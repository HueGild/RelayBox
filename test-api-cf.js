// RelayBox Phase 2 CF API parity test (Cloudflare Workers target).
// Usage: node test-api-cf.js <baseUrl> [outFile]
// Same scenario as test-api.js, adapted for the CF target's documented
// divergences from v2.8.4 / the VPS target:
// - /api/upload (multipart local upload) is VPS-only -> 501 on CF.
//   Test files are created via CHUNK upload instead (the CF way).
// - Every file lands in R2 (storage is normalised to 'r2'), so /f/:id
//   answers 302 to a presigned R2 URL instead of 200 with bytes. The test
//   verifies the 302 + the presigned URL shape; actual byte download and
//   Range need real R2 credentials (deployed Worker).
// - /api/upload-url returns 200 with a presigned PUT URL (R2 always on);
//   /api/upload-complete 400s when the object was never PUT.
// - list r2 flag is true on CF.
// The test password is 'testpass123' (see .dev.vars).

const BASE = process.argv[2];
const PW = process.env.CF_TEST_PW || 'testpass123'; // override via CF_TEST_PW for deployed Workers
if (!BASE) {
  console.error('usage: node test-api.js <baseUrl>');
  process.exit(1);
}

const results = [];
let passed = 0;
let failed = 0;

function norm(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return '<ts>';
    return v;
  }
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (['id', 'token', 'shareToken', 'uploadId'].includes(k)) out[k] = '<id>';
      else if (['createdAt', 'uploadedAt', 'expiresAt'].includes(k)) out[k] = '<ts>';
      else if (k === 'uploadUrl') out[k] = '<url>';
      else out[k] = norm(val);
    }
    return out;
  }
  return v;
}
function normPath(p) {
  return p.replace(/\/([A-Za-z0-9_-]{8,})(?=[/?#]|$)/g, '/:id');
}

async function req(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    body = opts.body;
  }
  const r = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, json, text, headers: r.headers, setCookie: setCookie ? '<cookie>' : null };
}

function step(name, cond, detail) {
  const ok = !!cond;
  if (ok) passed++; else failed++;
  results.push({ step: name, ok, ...(detail !== undefined ? { detail: norm(detail) } : {}) });
  if (!ok) console.error('FAIL:', name, JSON.stringify(norm(detail)));
}

function expectJson(r, status, okVal, name) {
  const good = r.status === status && r.json && r.json.ok === okVal;
  step(name, good, { status: r.status, body: r.json });
  return good;
}

// ---- cookie jar (admin session) ----
let cookie = '';
async function authedReq(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  return req(method, path, { ...opts, headers });
}
function storeCookie(r) {
  if (r.setCookie) {
    const m = /fs_admin=([^;]+)/.exec(r.headers.get('set-cookie') || '');
    if (m) cookie = 'fs_admin=' + m[1];
  }
}

const S = {};
async function main() {
  // ---------- 1. auth ----------
  let r = await req('GET', '/api/me');
  expectJson(r, 200, true, 'me: guest not authed');
  step('me: guest username empty', r.json && r.json.authed === false && r.json.username === '', r.json);

  r = await req('POST', '/api/login', { json: { username: 'admin', password: 'wrong' } });
  expectJson(r, 401, false, 'login: wrong password 401');
  step('login: wrong password error text', r.json && r.json.error === '账号或密码不对', r.json);

  r = await req('POST', '/api/login', { json: { password: PW } });
  expectJson(r, 401, false, 'login: missing username 401');

  r = await req('POST', '/api/login', { json: { username: 'admin', password: PW } });
  expectJson(r, 200, true, 'login: ok');
  step('login: sets fs_admin cookie', !!r.setCookie, { setCookie: r.setCookie });
  step('login: returns username admin', r.json && r.json.username === 'admin', r.json);
  storeCookie(r);

  r = await authedReq('GET', '/api/me');
  step('me: authed after login', r.json && r.json.authed === true && r.json.username === 'admin', r.json);

  // ---------- 2. announcement ----------
  r = await req('GET', '/api/announcement');
  expectJson(r, 200, true, 'announce: guest read empty');
  step('announce: default empty', r.json && r.json.announcement === '', r.json);

  r = await req('POST', '/api/announcement', { json: { announcement: 'hello' } });
  expectJson(r, 401, false, 'announce: guest write 401');

  r = await authedReq('POST', '/api/announcement', { json: { announcement: '  hello world  ' } });
  expectJson(r, 200, true, 'announce: admin write ok');
  step('announce: trims', r.json && r.json.announcement === 'hello world', r.json);

  r = await authedReq('POST', '/api/announcement', { json: { announcement: 'x'.repeat(250) } });
  step('announce: truncates to 200', r.json && r.json.announcement.length === 200, { len: r.json && r.json.announcement.length });

  r = await req('GET', '/api/announcement');
  step('announce: guest reads set value', r.json && r.json.announcement.length === 200, { len: r.json && r.json.announcement.length });

  r = await authedReq('POST', '/api/announcement', { json: { announcement: '' } });
  step('announce: clear', r.json && r.json.announcement === '', r.json);

  // ---------- 3. folders ----------
  r = await req('GET', '/api/folders');
  expectJson(r, 401, false, 'folders: guest list 401');

  r = await authedReq('POST', '/api/folders', { json: { name: '软件' } });
  expectJson(r, 200, true, 'folders: create root folder');
  S.folderA = r.json.folder.id;
  step('folders: created has parentId null', r.json.folder.parentId === null, r.json.folder);

  r = await authedReq('POST', '/api/folders', { json: { name: '软件' } });
  expectJson(r, 400, false, 'folders: duplicate name 400');
  step('folders: dup error text', r.json && r.json.error === '同级已有同名文件夹', r.json);

  r = await authedReq('POST', '/api/folders', { json: { name: '子目录', parentId: S.folderA } });
  expectJson(r, 200, true, 'folders: create subfolder');
  S.folderB = r.json.folder.id;

  r = await authedReq('POST', '/api/folders', { json: { name: 'x', parentId: 'nope' } });
  expectJson(r, 400, false, 'folders: bad parent 400');

  r = await authedReq('POST', '/api/folders/' + S.folderB + '/move', { json: { parentId: S.folderB } });
  expectJson(r, 400, false, 'folders: move into self 400');
  step('folders: move-self error', r.json && r.json.error === '不能把文件夹移进自己', r.json);

  r = await authedReq('POST', '/api/folders/' + S.folderA + '/move', { json: { parentId: S.folderB } });
  expectJson(r, 400, false, 'folders: move into descendant 400');
  step('folders: move-desc error', r.json && r.json.error === '不能把文件夹移进自己的子文件夹', r.json);

  r = await authedReq('POST', '/api/folders/' + S.folderB + '/rename', { json: { name: '软件' } });
  expectJson(r, 200, true, 'folders: rename sub to same name as root ok (different parent)');

  r = await authedReq('POST', '/api/folders/' + S.folderB + '/rename', { json: { name: '工具' } });
  expectJson(r, 200, true, 'folders: rename ok');

  r = await authedReq('DELETE', '/api/folders/' + S.folderA);
  expectJson(r, 400, false, 'folders: delete non-empty (has subfolder) 400');
  step('folders: delete-subfolder error', r.json && r.json.error === '文件夹里还有子文件夹，先移走或删掉', r.json);

  r = await authedReq('GET', '/api/folders');
  step('folders: list has 2', r.json && r.json.folders.length === 2, { n: r.json && r.json.folders.length });

  // ---------- 4. multipart upload ----------
  const helloContent = 'hello relaybox\n'.repeat(10);
  async function uploadFile(name, content, opts = {}) {
    const fd = new FormData();
    if (opts.password !== undefined) fd.append('password', opts.password);
    fd.append('visibility', opts.visibility || 'private');
    fd.append('expires', String(opts.expires ?? 0));
    fd.append('folderId', opts.folderId || '');
    fd.append('file', new File([content], name, { type: opts.type || 'text/plain' }));
    const headers = {};
    if (opts.cookie) headers.Cookie = opts.cookie;
    return req('POST', '/api/upload', { body: fd, headers });
  }

  // CF way to create a file: chunk upload (single part for small files,
  // 5MB parts for big ones). Returns the /api/upload/chunk-complete response.
  // opts: { visibility, expires, storage ('local' is normalised to 'r2'), folderId, cookie }
  async function chunkUploadFile(name, buf, opts = {}) {
    const CH = 5 * 1024 * 1024;
    const size = buf.length;
    const total = Math.max(1, Math.ceil(size / CH));
    const uploadId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Upload-Password': PW };
    if (opts.cookie) headers.Cookie = opts.cookie;
    for (let i = 0; i < total; i++) {
      const qs = new URLSearchParams({
        uploadId, index: String(i), total: String(total), name, size: String(size),
        visibility: opts.visibility || 'private', expires: String(opts.expires ?? 0),
        storage: opts.storage || 'local', folderId: opts.folderId || '',
      }).toString();
      const r = await req('POST', '/api/upload/chunk?' + qs, {
        body: buf.subarray(i * CH, Math.min(size, (i + 1) * CH)), headers,
      });
      if (!r.json || !r.json.ok) return r; // surface the failing part response
    }
    const body = { uploadId, password: PW };
    return req('POST', '/api/upload/chunk-complete', { json: body, headers: opts.cookie ? { Cookie: opts.cookie } : {} });
  }

  // A presigned R2 GET URL: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>?X-Amz-Algorithm=...&X-Amz-Signature=...
  function isPresignedUrl(u) {
    if (typeof u !== 'string') return false;
    try {
      const url = new URL(u);
      return url.hostname.endsWith('.r2.cloudflarestorage.com')
        && url.searchParams.has('X-Amz-Algorithm')
        && url.searchParams.has('X-Amz-Signature')
        && url.searchParams.has('X-Amz-Expires');
    } catch { return false; }
  }
  // /f/:id on CF must 302 to a presigned R2 URL (optionally with a disposition).
  function stepRedirect302(r, label, wantDisposition) {
    const loc = r.headers.get('location') || '';
    const ok = r.status === 302 && isPresignedUrl(loc)
      && (!wantDisposition || loc.includes('response-content-disposition'));
    step(label, ok, { status: r.status, location: loc.slice(0, 120) + (loc.length > 120 ? '...' : '') });
    return ok;
  }

  // CF: /api/upload (multipart local upload) is VPS-only -> 501 for every
  // caller (the 501 check runs before auth in upload.js).
  r = await uploadFile('hello.txt', helloContent, { password: 'wrong' });
  expectJson(r, 501, false, 'upload: multipart 501 even with wrong password');
  step('upload: multipart error text', r.json && r.json.error === '本地上传仅支持 VPS', r.json);

  r = await uploadFile('hello.txt', helloContent, {});
  expectJson(r, 501, false, 'upload: multipart 501 with no password');

  r = await uploadFile('hello.txt', helloContent, { password: PW, visibility: 'public' });
  expectJson(r, 501, false, 'upload: multipart 501 even with correct password');

  // CF way to create files: chunk upload (single part for small files).
  r = await chunkUploadFile('hello.txt', Buffer.from(helloContent), { password: PW, visibility: 'public' });
  expectJson(r, 200, true, 'upload: chunk-create public');
  S.filePub = r.json.file.id;
  step('upload: file shape (r2)', r.json.file && r.json.file.storage === 'r2' && r.json.file.visibility === 'public' && r.json.file.kind === 'file', r.json.file);

  r = await chunkUploadFile('secret.txt', Buffer.from('top secret'), { cookie, visibility: 'private', folderId: S.folderA });
  expectJson(r, 200, true, 'upload: chunk-create authed private into folder');
  S.filePriv = r.json.file.id;
  step('upload: folderId kept', r.json.file.folderId === S.folderA, r.json.file);

  // ---------- 5. list / search ----------
  r = await req('GET', '/api/files');
  expectJson(r, 200, true, 'list: guest root');
  step('list: guest sees only public file', r.json.files.length === 1 && r.json.files[0].id === S.filePub, { n: r.json.files.length });
  step('list: guest sees no folders (empty public)', r.json.folders.length === 0, { n: r.json.folders.length });
  step('list: r2 flag true (CF always on)', r.json.r2 === true, r.json);
  step('list: path root', r.json.path && r.json.path.length === 1 && r.json.path[0].id === null, r.json.path);

  r = await authedReq('GET', '/api/files');
  step('list: admin sees 1 root file', r.json.files.length === 1, { n: r.json.files.length });
  step('list: admin sees folder 软件', r.json.folders.length === 1 && r.json.folders[0].name === '软件', r.json.folders);
  step('list: folder fileCount 1', r.json.folders[0].fileCount === 1, r.json.folders[0]);

  r = await authedReq('GET', '/api/files?folderId=' + S.folderA);
  step('list: folder A has private file', r.json.files.length === 1 && r.json.files[0].id === S.filePriv, { n: r.json.files.length });
  step('list: breadcrumb 2 levels', r.json.path.length === 2 && r.json.path[1].name === '软件', r.json.path);

  r = await req('GET', '/api/search?q=hello');
  step('search: guest finds public hello', r.json.files.length === 1, { n: r.json.files.length });
  r = await req('GET', '/api/search?q=secret');
  step('search: guest cannot find private', r.json.files.length === 0, { n: r.json.files.length });
  r = await authedReq('GET', '/api/search?q=secret');
  step('search: admin finds private', r.json.files.length === 1, { n: r.json.files.length });
  r = await req('GET', '/api/search?q=');
  step('search: empty q', r.json.files.length === 0 && r.json.total === 0, r.json);
  r = await authedReq('GET', '/api/search?q=软件');
  step('search: folder match', r.json.folders.length >= 1, { n: r.json.folders.length });

  // ---------- 6. download ----------
  // CF: every file is in R2, so /f/:id 302s to a presigned R2 GET URL.
  // Bytes + Range are served by the R2 edge, not the Worker — the test
  // verifies the redirect and the presigned URL shape here.
  r = await req('GET', '/f/' + S.filePub);
  stepRedirect302(r, 'download: public inline 302 to presigned R2 URL');
  step('download: inline disposition in presigned URL', (r.headers.get('location') || '').includes('response-content-disposition=inline'), { loc: (r.headers.get('location') || '').slice(0, 160) });

  r = await req('GET', '/f/' + S.filePriv);
  expectJson(r, 403, false, 'download: private guest 403');

  r = await authedReq('GET', '/f/' + S.filePriv);
  stepRedirect302(r, 'download: private admin 302');

  r = await req('GET', '/f/' + S.filePub, { headers: { Range: 'bytes=0-4' } });
  // Range is NOT answered by the Worker on CF: the browser re-sends it to
  // the presigned URL, so the Worker still answers 302 (not 206).
  stepRedirect302(r, 'download: range request also 302 (Range goes to R2)');

  r = await req('GET', '/f/' + S.filePub, { headers: { Range: 'bytes=-6' } });
  stepRedirect302(r, 'download: suffix range also 302 (no 416 quirk on CF)');

  r = await req('GET', '/f/' + S.filePub, { headers: { Range: 'bytes=99999-' } });
  stepRedirect302(r, 'download: bad range also 302 (Range goes to R2)');

  r = await req('GET', '/f/nonexistent');
  expectJson(r, 404, false, 'download: missing file 404');

  // download count: only ?download=1 counts (counted before the 302)
  r = await authedReq('GET', '/api/files?folderId=' + S.folderA);
  const d0 = r.json.files[0].downloads;
  await req('GET', '/f/' + S.filePub); // preview, no count
  r = await authedReq('GET', '/api/files');
  step('download: preview does not count', r.json.files[0].downloads === d0, { d0, d1: r.json.files[0].downloads });
  await req('GET', '/f/' + S.filePub + '?download=1');
  r = await authedReq('GET', '/api/files');
  step('download: ?download=1 counts', r.json.files[0].downloads === d0 + 1, { d0, d1: r.json.files[0].downloads });
  // ?download=1 must produce an attachment disposition in the presigned URL
  r = await req('GET', '/f/' + S.filePub + '?download=1');
  stepRedirect302(r, 'download: ?download=1 is 302', true);

  // ---------- 7. file ops ----------
  r = await authedReq('POST', '/api/files/' + S.filePriv + '/visibility', { json: { visibility: 'bogus' } });
  expectJson(r, 400, false, 'visibility: bad value 400');
  r = await authedReq('POST', '/api/files/' + S.filePriv + '/visibility', { json: { visibility: 'public' } });
  expectJson(r, 200, true, 'visibility: to public');
  r = await req('GET', '/f/' + S.filePriv);
  stepRedirect302(r, 'visibility: now public for guest (302)');
  await authedReq('POST', '/api/files/' + S.filePriv + '/visibility', { json: { visibility: 'private' } });

  r = await authedReq('POST', '/api/files/' + S.filePriv + '/expiry', { json: { expiresHours: 24 } });
  expectJson(r, 200, true, 'expiry: set 24h');
  step('expiry: expiresAt ~24h ahead', r.json.file.expiresAt && (new Date(r.json.file.expiresAt) - Date.now()) > 23 * 3600 * 1000, r.json.file.expiresAt);
  r = await authedReq('POST', '/api/files/' + S.filePriv + '/expiry', { json: { expiresHours: 999 } });
  step('expiry: bad value -> permanent', r.json.file.expiresAt === null, r.json.file);

  r = await authedReq('POST', '/api/files/' + S.filePriv + '/rename', { json: { name: 'hello.txt' } });
  expectJson(r, 200, true, 'rename: same-folder dup name allowed across folders');
  r = await authedReq('POST', '/api/files/' + S.filePriv + '/rename', { json: { name: 'renamed.txt' } });
  expectJson(r, 200, true, 'rename: ok');
  step('rename: ext/kind updated', r.json.file.name === 'renamed.txt' && r.json.file.ext === '.txt', r.json.file);
  r = await authedReq('GET', '/f/' + S.filePriv);
  stepRedirect302(r, 'rename: download still works by id (302)');

  r = await authedReq('POST', '/api/files/' + S.filePriv + '/move', { json: { folderId: S.folderB } });
  expectJson(r, 200, true, 'move file to subfolder');
  r = await authedReq('POST', '/api/files/' + S.filePriv + '/move', { json: { folderId: 'nope' } });
  expectJson(r, 400, false, 'move file: bad folder 400');

  // ---------- 8. shares ----------
  r = await authedReq('POST', '/api/files/' + S.filePub + '/share', { json: {} });
  expectJson(r, 200, true, 'share: create file share');
  S.shareFile = r.json.token;
  step('share: no code/burn by default', r.json.code === null && r.json.burn === false, r.json);

  r = await authedReq('GET', '/api/files/' + S.filePub + '/share');
  step('share: get returns token', r.json.share && r.json.share.token === S.shareFile, r.json);

  r = await req('GET', '/api/share/' + S.shareFile);
  expectJson(r, 200, true, 'share: public info');
  step('share: info file name', r.json.file && r.json.file.name === 'hello.txt', r.json.file);

  r = await authedReq('POST', '/api/files/' + S.filePub + '/share', { json: { code: 'abc123', burn: true } });
  step('share: set code+burn', r.json.code === 'abc123' && r.json.burn === true, r.json);

  r = await req('GET', '/api/share/' + S.shareFile);
  expectJson(r, 403, false, 'share: code required');
  step('share: needCode flag', r.json.needCode === true, r.json);
  r = await req('GET', '/api/share/' + S.shareFile + '?code=wrong');
  expectJson(r, 403, false, 'share: wrong code 403');
  r = await req('GET', '/api/share/' + S.shareFile + '?code=abc123');
  expectJson(r, 200, true, 'share: right code ok');

  // burn: download via share link burns it
  r = await req('GET', '/f/' + S.filePub + '?download=1&share=' + S.shareFile + '&code=abc123');
  stepRedirect302(r, 'share: burn download 302');
  r = await req('GET', '/api/share/' + S.shareFile + '?code=abc123');
  expectJson(r, 404, false, 'share: burned after download');

  // private file via file share (no code)
  r = await authedReq('POST', '/api/files/' + S.filePriv + '/share', { json: {} });
  S.sharePriv = r.json.token;
  r = await req('GET', '/f/' + S.filePriv + '?share=' + S.sharePriv);
  stepRedirect302(r, 'share: private file via token (preview, 302)');
  r = await req('GET', '/f/' + S.filePriv + '?share=badtoken');
  expectJson(r, 403, false, 'share: bad token 403');

  // folder share: all files visible incl. private
  r = await authedReq('POST', '/api/folders/' + S.folderA + '/share', { json: {} });
  expectJson(r, 200, true, 'share: create folder share');
  S.shareFolder = r.json.token;
  r = await req('GET', '/api/share/' + S.shareFolder);
  expectJson(r, 200, true, 'share: folder info');
  step('share: folder lists subfolders', r.json.folders.length === 1, r.json.folders);
  step('share: folder files (root of share) empty', r.json.files.length === 0, { n: r.json.files.length });
  r = await req('GET', '/api/share/' + S.shareFolder + '?folderId=' + S.folderB);
  step('share: subfolder browse', r.json.files.length === 1 && r.json.files[0].name === 'renamed.txt', { n: r.json.files.length });
  r = await req('GET', '/api/share/' + S.shareFolder + '?folderId=outside');
  expectJson(r, 404, false, 'share: outside tree 404');
  // private file inside shared folder is downloadable via the folder token
  r = await req('GET', '/f/' + S.filePriv + '?share=' + S.shareFolder);
  stepRedirect302(r, 'share: private file via folder token (302)');

  r = await authedReq('DELETE', '/api/files/' + S.filePub + '/share');
  expectJson(r, 200, true, 'share: revoke file share');
  r = await authedReq('GET', '/api/files/' + S.filePub + '/share');
  step('share: revoked -> null', r.json.share === null, r.json);

  r = await authedReq('DELETE', '/api/folders/' + S.folderA + '/share');
  expectJson(r, 200, true, 'share: revoke folder share');

  // ---------- 9. thumbs ----------
  // upload a tiny PNG as an image file (via chunk upload on CF), then a thumb for it
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  r = await chunkUploadFile('pic.png', png1x1, { cookie, visibility: 'public' });
  expectJson(r, 200, true, 'thumb: chunk-upload image file');
  S.img = r.json.file.id;
  step('thumb: kind image', r.json.file.kind === 'image', r.json.file);

  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
  r = await authedReq('POST', '/api/thumbs/' + S.img, { body: fakeJpeg, headers: { 'Content-Type': 'image/jpeg' } });
  expectJson(r, 200, true, 'thumb: upload ok');
  r = await req('GET', '/thumb/' + S.img);
  step('thumb: guest view public', r.status === 200 && (r.headers.get('content-type') || '').includes('image/jpeg'), { status: r.status });
  r = await req('GET', '/thumb/' + S.filePriv);
  expectJson(r, 404, false, 'thumb: private file thumb 404 for guest');
  r = await authedReq('POST', '/api/thumbs/' + S.filePub, { body: fakeJpeg, headers: { 'Content-Type': 'image/jpeg' } });
  expectJson(r, 400, false, 'thumb: non-image file 400');
  r = await authedReq('POST', '/api/thumbs/' + S.img, { body: fakeJpeg, headers: { 'Content-Type': 'text/plain' } });
  expectJson(r, 400, false, 'thumb: wrong content-type 400');
  r = await authedReq('POST', '/api/thumbs/nope', { body: fakeJpeg, headers: { 'Content-Type': 'image/jpeg' } });
  expectJson(r, 404, false, 'thumb: missing file 404');

  // ---------- 10. chunk upload ----------
  const CHUNK = 5 * 1024 * 1024;
  const bigSize = CHUNK * 2 + 12345;
  const bigBuf = Buffer.alloc(bigSize, 0x61);
  const uploadId = 'c' + Date.now().toString(36) + 'testchunk';
  const qs = (i) => new URLSearchParams({
    uploadId, index: String(i), total: '3', name: 'big.bin', size: String(bigSize),
    visibility: 'private', expires: '0', storage: 'local', folderId: '',
  }).toString();
  const chunkHeaders = { 'Content-Type': 'application/octet-stream', 'X-Upload-Password': PW };

  r = await req('GET', '/api/upload/chunk-status?uploadId=' + uploadId, { headers: { 'X-Upload-Password': PW } });
  step('chunk: status empty', r.json && r.json.ok && r.json.received.length === 0 && r.json.meta === null, r.json);

  r = await req('POST', '/api/upload/chunk?' + qs(0), { body: bigBuf.subarray(0, CHUNK), headers: chunkHeaders });
  expectJson(r, 200, true, 'chunk: part 0 ok');
  step('chunk: part 0 response', r.json.received === 0 && r.json.done === 1 && r.json.total === 3, r.json);

  r = await req('POST', '/api/upload/chunk?' + qs(0), { body: bigBuf.subarray(0, CHUNK), headers: chunkHeaders });
  step('chunk: re-send part 0 ok (idempotent)', r.json && r.json.ok && r.json.done === 1, r.json);

  r = await req('GET', '/api/upload/chunk-status?uploadId=' + uploadId, { headers: { 'X-Upload-Password': PW } });
  step('chunk: status has [0]', JSON.stringify(r.json.received) === '[0]', r.json);

  r = await req('POST', '/api/upload/chunk?' + qs(1), { body: bigBuf.subarray(0, 100), headers: chunkHeaders });
  expectJson(r, 400, false, 'chunk: wrong part size 400');
  step('chunk: wrong size error', r.json && r.json.error === '分片大小不对', r.json);

  r = await req('POST', '/api/upload/chunk?' + qs(1), { body: bigBuf.subarray(CHUNK, CHUNK * 2), headers: chunkHeaders });
  expectJson(r, 200, true, 'chunk: part 1 ok');
  r = await req('POST', '/api/upload/chunk?' + qs(2), { body: bigBuf.subarray(CHUNK * 2), headers: chunkHeaders });
  expectJson(r, 200, true, 'chunk: part 2 (last, short) ok');

  r = await req('POST', '/api/upload/chunk-complete', { json: { uploadId, password: PW } });
  expectJson(r, 200, true, 'chunk: complete ok');
  S.bigFile = r.json.file.id;
  step('chunk: assembled size', r.json.file.size === bigSize, r.json.file);
  // CF normalises the requested 'local' storage to 'r2' (no local disk).
  step('chunk: storage r2 (local normalised)', r.json.file.storage === 'r2', r.json.file);
  r = await req('GET', '/f/' + S.bigFile, { headers: { Cookie: cookie } });
  stepRedirect302(r, 'chunk: assembled file downloads as 302');

  // chunk-complete with missing parts
  const uid2 = 'c' + Date.now().toString(36) + 'partial';
  const qs2 = (i) => new URLSearchParams({
    uploadId: uid2, index: String(i), total: '2', name: 'p.bin', size: String(CHUNK + 10),
    visibility: 'private', expires: '0', storage: 'local', folderId: '',
  }).toString();
  await req('POST', '/api/upload/chunk?' + qs2(0), { body: bigBuf.subarray(0, CHUNK), headers: chunkHeaders });
  r = await req('POST', '/api/upload/chunk-complete', { json: { uploadId: uid2, password: PW } });
  expectJson(r, 400, false, 'chunk: complete missing part 400');
  step('chunk: missing part error', r.json && r.json.error === '还缺第 2 片', r.json);

  // chunk mismatch (different name/size for same uploadId)
  const qs3 = new URLSearchParams({
    uploadId: uid2, index: '1', total: '2', name: 'other.bin', size: String(CHUNK + 10),
    visibility: 'private', expires: '0', storage: 'local', folderId: '',
  }).toString();
  r = await req('POST', '/api/upload/chunk?' + qs3, { body: bigBuf.subarray(0, 10), headers: chunkHeaders });
  expectJson(r, 400, false, 'chunk: meta mismatch 400');
  step('chunk: mismatch error', r.json && r.json.error === '分片信息和首次不一致', r.json);

  r = await req('POST', '/api/upload/chunk-complete', { json: { uploadId: 'nosuch', password: PW } });
  expectJson(r, 404, false, 'chunk: complete unknown 404');

  // ---------- 10b. large file: >100MB via chunk upload (CF R2 multipart) ----------
  // 105MB = 21 parts of 5MB. Proves the R2 multipart path (pitfall #1's
  // index+1 mapping + part sorting) works at real scale, end to end.
  const LARGE_MB = 105;
  const largeSize = LARGE_MB * 1024 * 1024;
  const largeBuf = Buffer.alloc(largeSize, 0x62); // 'b' * 105MB
  const largeUploadId = 'c' + Date.now().toString(36) + 'large105';
  const largeTotal = Math.ceil(largeSize / CHUNK);
  const largeQs = (i) => new URLSearchParams({
    uploadId: largeUploadId, index: String(i), total: String(largeTotal), name: 'large.bin', size: String(largeSize),
    visibility: 'private', expires: '0', storage: 'r2', folderId: '',
  }).toString();
  let largeOk = true;
  for (let i = 0; i < largeTotal; i++) {
    const pr = await req('POST', '/api/upload/chunk?' + largeQs(i), {
      body: largeBuf.subarray(i * CHUNK, Math.min(largeSize, (i + 1) * CHUNK)), headers: chunkHeaders,
    });
    if (!pr.json || !pr.json.ok) { largeOk = false; step('large: part ' + i + ' ok', false, pr.json); break; }
  }
  step('large: all ' + largeTotal + ' parts uploaded', largeOk, { parts: largeTotal, sizeMB: LARGE_MB });
  r = await req('GET', '/api/upload/chunk-status?uploadId=' + largeUploadId, { headers: { 'X-Upload-Password': PW } });
  step('large: status shows all parts', r.json && r.json.received.length === largeTotal, { n: r.json && r.json.received.length });
  r = await req('POST', '/api/upload/chunk-complete', { json: { uploadId: largeUploadId, password: PW } });
  expectJson(r, 200, true, 'large: complete ok');
  S.largeFile = r.json.file && r.json.file.id;
  step('large: assembled size 105MB', r.json.file && r.json.file.size === largeSize, { size: r.json.file && r.json.file.size });
  step('large: storage r2', r.json.file && r.json.file.storage === 'r2', r.json.file);
  r = await req('GET', '/f/' + S.largeFile, { headers: { Cookie: cookie } });
  stepRedirect302(r, 'large: download 302 to presigned R2 URL');
  // Range on a big file: still a 302 (Range is re-sent to R2 by the browser).
  r = await req('GET', '/f/' + S.largeFile, { headers: { Cookie: cookie, Range: 'bytes=104857600-' } });
  stepRedirect302(r, 'large: range (video scrub) 302');
  // Cleanup: delete the big file so the local R2 state stays small.
  r = await authedReq('DELETE', '/api/files/' + S.largeFile, { json: {} });
  expectJson(r, 200, true, 'large: delete ok');

  // ---------- 11. R2 presigned (always enabled on CF) ----------
  r = await authedReq('POST', '/api/upload-url', { json: { name: 'a.bin', size: 100 } });
  expectJson(r, 200, true, 'r2: upload-url 200 when enabled');
  step('r2: upload-url is a presigned PUT URL', isPresignedUrl(r.json.uploadUrl) && r.json.uploadUrl.includes('X-Amz-Algorithm'), { url: (r.json.uploadUrl || '').slice(0, 140) });
  step('r2: upload-url returns id/key/expiresIn', !!(r.json.id && r.json.key && r.json.expiresIn === 900), { id: !!r.json.id, key: r.json.key, expiresIn: r.json.expiresIn });
  // upload-complete: the object was never PUT to R2, so head() finds nothing.
  r = await authedReq('POST', '/api/upload-complete', { json: { id: r.json.id, key: r.json.key, name: 'a.bin', size: 100 } });
  expectJson(r, 400, false, 'r2: upload-complete 400 when object missing');
  step('r2: upload-complete missing-object error', r.json && r.json.error === 'R2 里没有这个文件，请重新上传', r.json);
  // bad params still 400
  r = await authedReq('POST', '/api/upload-complete', { json: { id: 'x', key: 'x_a.bin', name: 'a.bin', size: 100 } });
  expectJson(r, 400, false, 'r2: upload-complete bad key 400');

  // ---------- 12. delete + folder cleanup ----------
  r = await authedReq('DELETE', '/api/files/' + S.bigFile, { json: {} });
  expectJson(r, 200, true, 'delete: chunked file ok');
  r = await req('GET', '/f/' + S.bigFile);
  expectJson(r, 404, false, 'delete: gone');

  r = await authedReq('DELETE', '/api/files/' + S.filePriv, { json: {} });
  expectJson(r, 200, true, 'delete: private file ok');
  r = await authedReq('DELETE', '/api/folders/' + S.folderA);
  expectJson(r, 400, false, 'folders: still has subfolder 400');
  r = await authedReq('DELETE', '/api/folders/' + S.folderB);
  expectJson(r, 200, true, 'folders: delete empty subfolder');
  r = await authedReq('DELETE', '/api/folders/' + S.folderA);
  expectJson(r, 200, true, 'folders: delete now-empty folder');
  r = await authedReq('DELETE', '/api/folders/nope');
  expectJson(r, 404, false, 'folders: delete missing 404');

  // ---------- 13. misc ----------
  r = await req('GET', '/api/unknown-path');
  expectJson(r, 404, false, 'misc: unknown route 404');
  r = await req('GET', '/s/abc123');
  step('misc: /s/ returns html', r.status === 200 && r.text.includes('<!DOCTYPE html') || r.text.includes('<html'), { status: r.status });
  r = await req('GET', '/qrcode.min.js');
  step('misc: qrcode.js 200', r.status === 200, { status: r.status });

  // ---------- 14. logout ----------
  r = await authedReq('POST', '/api/logout', { json: {} });
  expectJson(r, 200, true, 'logout: ok');
  r = await authedReq('GET', '/api/me');
  step('logout: session gone', r.json && r.json.authed === false, r.json);

  // ---------- 15. rate limit (isolated fake IP via X-Forwarded-For) ----------
  const badIp = { 'X-Forwarded-For': '203.0.113.99' };
  for (let i = 0; i < 5; i++) {
    await req('POST', '/api/login', { json: { username: 'admin', password: 'nope' }, headers: badIp });
  }
  r = await req('POST', '/api/login', { json: { username: 'admin', password: 'nope' }, headers: badIp });
  expectJson(r, 429, false, 'ratelimit: 6th attempt 429');
  step('ratelimit: error text', r.json && r.json.error === '尝试太频繁，10 分钟后再试', r.json);
  r = await req('POST', '/api/login', { json: { username: 'admin', password: PW }, headers: badIp });
  expectJson(r, 429, false, 'ratelimit: correct password still blocked');

  console.log(JSON.stringify({ summary: { passed, failed, total: passed + failed } }));
  for (const line of results) console.log(JSON.stringify(line));
}

main().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(1);
});
