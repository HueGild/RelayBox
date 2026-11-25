// v3.3.10 verification: Share Management Center (GET/DELETE /api/shares) + Batch API (POST /api/files/batch).
// Builds the Hono app in-process with CF R2Storage + an in-memory mock R2 binding
// + JsonMetaStore. No external network. Also verifies single-file API contracts
// are preserved and JsonMetaStore batch methods write disk only once.
// Usage: node v3310-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './src/core/app.js';
import { JsonMetaStore } from './src/adapters/node/json-meta.js';
import { R2Storage } from './src/adapters/cf/r2-storage.js';

const PW = 'testpass123';
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS:', name); }
  else { failed++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''); }
}

async function toBytes(body) {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
}
class MockR2 {
  constructor() { this.store = new Map(); }
  async put(key, body, opts) {
    const bytes = await toBytes(body);
    this.store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType || 'application/octet-stream', etag: '"mock-' + key.length + '-' + bytes.byteLength + '"' });
  }
  _obj(key, bytes, totalSize, etag, contentType) {
    const buf = bytes;
    return {
      body: new ReadableStream({ start(c) { c.enqueue(buf); c.close(); } }),
      size: totalSize,
      httpEtag: etag,
      httpMetadata: { contentType },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }
  async get(key, opts) {
    const rec = this.store.get(key);
    if (!rec) return null;
    if (opts?.range) {
      const { offset, length } = opts.range;
      return this._obj(key, rec.bytes.slice(offset, offset + length), rec.bytes.length, rec.etag, rec.contentType);
    }
    return this._obj(key, rec.bytes, rec.bytes.length, rec.etag, rec.contentType);
  }
  async head(key) {
    const rec = this.store.get(key);
    return rec ? { size: rec.bytes.length } : null;
  }
  async delete(key) { this.store.delete(key); }
  createMultipartUpload() { throw new Error('multipart not mocked'); }
  resumeMultipartUpload() { throw new Error('multipart not mocked'); }
}

function buildDeps({ root, mockR2 }) {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const r2 = new R2Storage({ binding: mockR2, bucket: 'test-bucket', accountId: '', accessKeyId: '', secretAccessKey: '' });
  const meta = new JsonMetaStore(dataDir);
  return {
    meta, local: r2, r2,
    fetch: async () => new Response('{}', { status: 200 }),
    config: {
      uploadPassword: PW,
      maxUploadSize: 10 * 1024 * 1024 * 1024,
      chunkUploadThreshold: 100 * 1024 * 1024,
      proxyChunkUploadThreshold: 20 * 1024 * 1024,
      proxyUploadMaxBytes: 20 * 1024 * 1024,
      chunkSize: 20 * 1024 * 1024,
      defaultTransferMode: 'presign',
      textMaxBytes: 1024 * 1024,
      trashTtlMs: 7 * 24 * 3600 * 1000,
    },
    getClientIp: () => '203.0.113.7',
    getClientGeo: () => 'CN · Guangdong · Shenzhen',
    _mockR2: mockR2,
  };
}

async function req(app, method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  const r = await app.request(path, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function login(app) {
  const r = await req(app, 'POST', '/api/login', { json: { username: 'admin', password: PW } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function uploadProxy(app, H, name, bytes, extra = '') {
  const size = bytes.byteLength;
  const r = await req(app, 'POST', `/api/upload-proxy?name=${encodeURIComponent(name)}&size=${size}${extra}`, {
    headers: H, body: bytes,
  });
  if (!(r.status === 200 && r.json && r.json.ok)) throw new Error('upload-proxy failed: ' + JSON.stringify(r.json));
  return r.json.file;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-v3310-'));
const mockR2 = new MockR2();
const deps = buildDeps({ root, mockR2 });
const app = createApp(deps);
const cookie = await login(app);
const H = { 'Cookie': cookie, 'X-Upload-Password': PW };
const imgBytes = fs.readFileSync('/home/hatch/relaybox-test-r7/test-img.png');

// ================= A. 分享管理中心 GET /api/shares =================
console.log('\n--- A. GET /api/shares ---');
const pubImg = await uploadProxy(app, H, 'v3310-public.png', imgBytes, '&visibility=public');
const privTxt = await uploadProxy(app, H, 'v3310-private.txt', new TextEncoder().encode('hello v3310'), '&visibility=private');
const folder = await req(app, 'POST', '/api/folders', { headers: H, json: { name: 'v3310-目录', parentId: null } });
check('A0 setup: files + folder created', !!pubImg.id && !!privTxt.id && folder.json.ok, { pubImg: pubImg.id, privTxt: privTxt.id, folder: folder.json });

const shImg = await req(app, 'POST', `/api/files/${pubImg.id}/share`, { headers: H, json: {} });
const shTxt = await req(app, 'POST', `/api/files/${privTxt.id}/share`, { headers: H, json: { maxDownloads: 5 } });
const shFolder = await req(app, 'POST', `/api/folders/${folder.json.folder.id}/share`, { headers: H, json: {} });
check('A1 create 3 shares ok', shImg.json.token && shTxt.json.token && shFolder.json.token, { shImg: shImg.json.token, shTxt: shTxt.json.token, shFolder: shFolder.json.token });

const unauthShares = await req(app, 'GET', '/api/shares', {});
check('A2 GET /api/shares unauthed -> 401', unauthShares.status === 401, unauthShares.status);
const sharesRes = await req(app, 'GET', '/api/shares', { headers: H });
check('A3 GET /api/shares admin 200', sharesRes.status === 200 && sharesRes.json.ok, sharesRes.status);
check('A4 counts all=3 active=3 inactive=0', sharesRes.json.counts && sharesRes.json.counts.all === 3 && sharesRes.json.counts.active === 3 && sharesRes.json.counts.inactive === 0, sharesRes.json.counts);
const eImg = (sharesRes.json.shares || []).find(s => s.token === shImg.json.token);
const eTxt = (sharesRes.json.shares || []).find(s => s.token === shTxt.json.token);
const eFolder = (sharesRes.json.shares || []).find(s => s.token === shFolder.json.token);
check('A5 file share entry: type=file, targetName, status=active', eImg && eImg.type === 'file' && eImg.targetName === 'v3310-public.png' && eImg.status === 'active', eImg);
check('A6 file share entry has pickupCode + remainingDownloads=null (unlimited)', eImg && !!eImg.pickupCode && eImg.pickupCode.length === 5 && eImg.maxDownloads === 0 && eImg.remainingDownloads === null, eImg);
check('A7 limited share: maxDownloads=5, remainingDownloads=5', eTxt && eTxt.maxDownloads === 5 && eTxt.usedDownloads === 0 && eTxt.remainingDownloads === 5, eTxt);
check('A8 folder share entry: type=folder, targetName', eFolder && eFolder.type === 'folder' && eFolder.targetName === 'v3310-目录' && eFolder.status === 'active', eFolder);
check('A9 shares sorted by createdAt desc', (sharesRes.json.shares || []).length === 3, sharesRes.json.shares && sharesRes.json.shares.map(s => s.targetName));

// exhausted: limited share (maxDownloads=2, NOT burn), download twice
const burnFile = await uploadProxy(app, H, 'v3310-burn.png', imgBytes, '&visibility=public');
const shBurn = await req(app, 'POST', `/api/files/${burnFile.id}/share`, { headers: H, json: { maxDownloads: 2 } });
check('A10 limited share created (maxDownloads=2, burn=false)', shBurn.json.token && shBurn.json.maxDownloads === 2 && shBurn.json.burn === false, shBurn.json);
const dlBurn1 = await req(app, 'GET', `/f/${burnFile.id}?share=${shBurn.json.token}&download=1`, {});
const dlBurn2 = await req(app, 'GET', `/f/${burnFile.id}?share=${shBurn.json.token}&download=1`, {});
check('A11 limited share downloads 200 x2', dlBurn1.status === 200 && dlBurn2.status === 200, { d1: dlBurn1.status, d2: dlBurn2.status });
const sharesAfterBurn = await req(app, 'GET', '/api/shares', { headers: H });
const eBurn = (sharesAfterBurn.json.shares || []).find(s => s.token === shBurn.json.token);
check('A12 limited share status=exhausted after 2 downloads (NOT deleted)', eBurn && eBurn.status === 'exhausted' && eBurn.usedDownloads === 2 && eBurn.remainingDownloads === 0, eBurn);
check('A13 counts after burn: all=4 active=3 inactive=1', sharesAfterBurn.json.counts.all === 4 && sharesAfterBurn.json.counts.active === 3 && sharesAfterBurn.json.counts.inactive === 1, sharesAfterBurn.json.counts);
// maxDownloads=1 is burn by design: deleted after one use
const burn1File = await uploadProxy(app, H, 'v3310-burn1.png', imgBytes, '&visibility=public');
const shBurn1 = await req(app, 'POST', `/api/files/${burn1File.id}/share`, { headers: H, json: { maxDownloads: 1 } });
check('A13b maxDownloads=1 creates burn=true share', shBurn1.json.token && shBurn1.json.burn === true, shBurn1.json);
const dlBurn1x = await req(app, 'GET', `/f/${burn1File.id}?share=${shBurn1.json.token}&download=1`, {});
check('A13c burn share download 200', dlBurn1x.status === 200, dlBurn1x.status);
const sharesAfterBurn1 = await req(app, 'GET', '/api/shares', { headers: H });
check('A13d burn share deleted after one use (not in list)', !(sharesAfterBurn1.json.shares || []).some(s => s.token === shBurn1.json.token), sharesAfterBurn1.json.counts);

// expired: file with expiresAt in the past
const expFile = await uploadProxy(app, H, 'v3310-exp.png', imgBytes, '&visibility=public&expires=1');
await deps.meta.updateFile(expFile.id, { expiresAt: new Date(Date.now() - 3600 * 1000).toISOString() });
const shExp = await req(app, 'POST', `/api/files/${expFile.id}/share`, { headers: H, json: {} });
const sharesAfterExp = await req(app, 'GET', '/api/shares', { headers: H });
const eExp = (sharesAfterExp.json.shares || []).find(s => s.token === shExp.json.token);
check('A14 expired file share status=expired', eExp && eExp.status === 'expired', eExp);

// missing: folder share becomes orphan when the (empty) folder is deleted
// (folder delete does NOT revoke its share — that is the real 'missing' path;
// physical file delete DOES revoke its share via purgeFilePermanently)
const missFolder = await req(app, 'POST', '/api/folders', { headers: H, json: { name: 'v3310-待删目录', parentId: null } });
const shMiss = await req(app, 'POST', `/api/folders/${missFolder.json.folder.id}/share`, { headers: H, json: {} });
check('A15 folder share created for orphan test', shMiss.json.token, shMiss.json);
const delMiss = await req(app, 'DELETE', `/api/folders/${missFolder.json.folder.id}`, { headers: H });
check('A15b empty folder deleted ok', delMiss.status === 200 && delMiss.json.ok, delMiss.json);
const sharesAfterMiss = await req(app, 'GET', '/api/shares', { headers: H });
const eMiss = (sharesAfterMiss.json.shares || []).find(s => s.token === shMiss.json.token);
check('A16 orphan folder share status=missing', eMiss && eMiss.status === 'missing' && eMiss.targetName.includes('已删除'), eMiss);

// ================= B. DELETE /api/shares/:token =================
console.log('\n--- B. DELETE /api/shares/:token ---');
const delUnauth = await req(app, 'DELETE', `/api/shares/${shTxt.json.token}`, {});
check('B1 DELETE /api/shares/:token unauthed -> 401', delUnauth.status === 401, delUnauth.status);
const delShare = await req(app, 'DELETE', `/api/shares/${shTxt.json.token}`, { headers: H });
check('B2 DELETE /api/shares/:token admin 200', delShare.status === 200 && delShare.json.ok, delShare.json);
const sharesAfterDel = await req(app, 'GET', '/api/shares', { headers: H });
check('B3 share gone from GET /api/shares', !(sharesAfterDel.json.shares || []).some(s => s.token === shTxt.json.token), sharesAfterDel.json.counts);
const getDeleted = await req(app, 'GET', `/api/share/${shTxt.json.token}`, {});
check('B4 GET /api/share/:token after revoke -> 404', getDeleted.status === 404, getDeleted.status);
// orphan cleanup: delete the missing share
const delOrphan = await req(app, 'DELETE', `/api/shares/${shMiss.json.token}`, { headers: H });
check('B5 DELETE orphan (missing) share 200', delOrphan.status === 200 && delOrphan.json.ok, delOrphan.json);
const sharesAfterOrphan = await req(app, 'GET', '/api/shares', { headers: H });
check('B6 orphan share gone', !(sharesAfterOrphan.json.shares || []).some(s => s.token === shMiss.json.token), sharesAfterOrphan.json.counts);

// ================= C. POST /api/files/batch =================
console.log('\n--- C. POST /api/files/batch ---');
const unauthBatch = await req(app, 'POST', '/api/files/batch', { json: { action: 'move', ids: [pubImg.id], folderId: folder.json.folder.id } });
check('C1 batch unauthed -> 401', unauthBatch.status === 401, unauthBatch.status);
const emptyBatch = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'move', ids: [], folderId: null } });
check('C2 batch empty ids -> 400', emptyBatch.status === 400, emptyBatch.status);
const badAction = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'explode', ids: [pubImg.id] } });
check('C3 batch unknown action -> 400', badAction.status === 400, badAction.status);
const tooMany = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'move', ids: Array.from({ length: 501 }, (_, i) => 'x' + i), folderId: null } });
check('C4 batch 501 ids -> 400', tooMany.status === 400, tooMany.status);
const badFolder = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'move', ids: [pubImg.id], folderId: 'no-such-folder' } });
check('C5 batch move to missing folder -> 400', badFolder.status === 400, badFolder.status);
const badVis = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'visibility', ids: [pubImg.id], visibility: 'weird' } });
check('C6 batch bad visibility -> 400', badVis.status === 400, badVis.status);

// move: 3 files -> target folder (with write-count instrumentation)
const m1 = await uploadProxy(app, H, 'v3310-m1.txt', new TextEncoder().encode('m1'), '&visibility=public');
const m2 = await uploadProxy(app, H, 'v3310-m2.txt', new TextEncoder().encode('m2'), '&visibility=public');
const m3 = await uploadProxy(app, H, 'v3310-m3.txt', new TextEncoder().encode('m3'), '&visibility=public');
let writeCount = 0;
const origWrite = deps.meta._writeFiles.bind(deps.meta);
deps.meta._writeFiles = (...a) => { writeCount++; return origWrite(...a); };
const moveRes = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'move', ids: [m1.id, m2.id, m3.id, m1.id], folderId: folder.json.folder.id } });
check('C7 batch move 3 files (dup id deduped) -> count=3', moveRes.status === 200 && moveRes.json.ok && moveRes.json.count === 3 && moveRes.json.updatedIds.length === 3, moveRes.json);
check('C8 batch move writes disk exactly once', writeCount === 1, writeCount);
const listInFolder = await req(app, 'GET', `/api/files?folderId=${folder.json.folder.id}`, { headers: H });
check('C9 moved files appear in target folder', (listInFolder.json.files || []).length === 3, (listInFolder.json.files || []).map(f => f.name));
const moveNotFound = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'move', ids: [m1.id, 'no-such-id'], folderId: null } });
check('C10 batch move with 1 missing id -> count=1, notFoundIds=[no-such-id]', moveNotFound.json.count === 1 && (moveNotFound.json.notFoundIds || []).includes('no-such-id'), moveNotFound.json);

// visibility: batch set private
writeCount = 0;
const visRes = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'visibility', ids: [m1.id, m2.id, m3.id], visibility: 'private' } });
check('C11 batch visibility -> count=3', visRes.status === 200 && visRes.json.count === 3, visRes.json);
check('C12 batch visibility writes disk exactly once', writeCount === 1, writeCount);
const f1AfterVis = await deps.meta.getFile(m1.id);
check('C13 file visibility now private', f1AfterVis.visibility === 'private', f1AfterVis.visibility);

// trash: batch trash with share revocation + single write
const t1 = await uploadProxy(app, H, 'v3310-t1.txt', new TextEncoder().encode('t1'), '&visibility=public');
const t2 = await uploadProxy(app, H, 'v3310-t2.txt', new TextEncoder().encode('t2'), '&visibility=public');
const shT1 = await req(app, 'POST', `/api/files/${t1.id}/share`, { headers: H, json: {} });
const shT2 = await req(app, 'POST', `/api/files/${t2.id}/share`, { headers: H, json: {} });
writeCount = 0;
let shareWriteCount = 0;
const origShareWrite = deps.meta._writeShares.bind(deps.meta);
deps.meta._writeShares = (...a) => { shareWriteCount++; return origShareWrite(...a); };
const trashRes = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'trash', ids: [t1.id, t2.id] } });
check('C14 batch trash 2 files -> count=2', trashRes.status === 200 && trashRes.json.count === 2 && trashRes.json.trashedIds.length === 2, trashRes.json);
check('C15 batch trash writes files disk exactly once', writeCount === 1, writeCount);
check('C16 batch trash writes shares disk exactly once (revoke)', shareWriteCount === 1, shareWriteCount);
const getShareT1 = await req(app, 'GET', `/api/share/${shT1.json.token}`, {});
const getShareT2 = await req(app, 'GET', `/api/share/${shT2.json.token}`, {});
check('C17 batch trash revokes both shares', getShareT1.status === 404 && getShareT2.status === 404, { t1: getShareT1.status, t2: getShareT2.status });
const trashList = await req(app, 'GET', '/api/trash', { headers: H });
check('C18 trashed files appear in GET /api/trash', (trashList.json.files || []).some(f => f.id === t1.id) && (trashList.json.files || []).some(f => f.id === t2.id), trashList.json.total);
const trashAgain = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'trash', ids: [t1.id, 'no-such-id'] } });
check('C19 batch trash again -> alreadyTrashedIds + notFoundIds', trashAgain.json.count === 0 && (trashAgain.json.alreadyTrashedIds || []).includes(t1.id) && (trashAgain.json.notFoundIds || []).includes('no-such-id'), trashAgain.json);

// ================= D. 单文件 API 契约保留 =================
console.log('\n--- D. Single-file API contracts preserved ---');
const singleMove = await req(app, 'POST', `/api/files/${m1.id}/move`, { headers: H, json: { folderId: null } });
check('D1 POST /api/files/:id/move still works', singleMove.status === 200 && singleMove.json.ok, singleMove.json);
const singleVis = await req(app, 'POST', `/api/files/${m1.id}/visibility`, { headers: H, json: { visibility: 'public' } });
check('D2 POST /api/files/:id/visibility still works', singleVis.status === 200 && singleVis.json.ok, singleVis.json);
const singleShare = await req(app, 'POST', `/api/files/${m1.id}/share`, { headers: H, json: {} });
check('D3 POST /api/files/:id/share still works', singleShare.status === 200 && !!singleShare.json.token, singleShare.json);
const singleGetShare = await req(app, 'GET', `/api/files/${m1.id}/share`, { headers: H });
check('D4 GET /api/files/:id/share still works', singleGetShare.status === 200 && singleGetShare.json.ok, singleGetShare.json);
const singleRename = await req(app, 'POST', `/api/files/${m1.id}/rename`, { headers: H, json: { name: 'v3310-m1-renamed.txt' } });
check('D5 POST /api/files/:id/rename still works', singleRename.status === 200 && singleRename.json.ok, singleRename.json);
const singleDel = await req(app, 'DELETE', `/api/files/${m2.id}`, { headers: H });
check('D6 DELETE /api/files/:id still works', singleDel.status === 200 && singleDel.json.ok, singleDel.json);
const singleTrash = await req(app, 'DELETE', `/api/files/${m3.id}?trash=1`, { headers: H });
check('D7 DELETE /api/files/:id?trash=1 still works', singleTrash.status === 200 && singleTrash.json.ok, singleTrash.json);

console.log(`\n=== v3.3.10 verify: passed ${passed}, failed ${failed} ===`);
if (failed) process.exitCode = 1;
