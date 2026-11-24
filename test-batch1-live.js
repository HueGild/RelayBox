// Batch 1 (v3.1) verification against a live Node server.
// Usage: node test-batch1-live.js <baseUrl>
// Covers: share maxDownloads mapping + pickupCode auto-gen/retain,
// GET /api/share/:token share field, GET /api/pickup/:code (+rate limit),
// /f/:id atomic decrement + 410, /api/tokens CRUD.
// Password: testpass123. R2 is disabled here (raw-upload tested separately).

const BASE = process.argv[2];
const PW = 'testpass123';
if (!BASE) { console.error('usage: node test-batch1-live.js <baseUrl>'); process.exit(1); }

let passed = 0, failed = 0;
function step(name, cond, detail) {
  if (cond) passed++; else { failed++; console.error('FAIL:', name, JSON.stringify(detail)); }
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
}

async function req(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  else if (opts.body !== undefined) { body = opts.body; }
  const r = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') };
}

let cookie = '';
async function authedReq(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  return req(method, path, { ...opts, headers });
}

const PICKUP_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;

async function uploadFile(name, content, visibility) {
  const fd = new FormData();
  fd.append('password', PW);
  if (visibility) fd.append('visibility', visibility);
  fd.append('file', new Blob([content], { type: 'text/plain' }), name);
  const r = await req('POST', '/api/upload', { body: fd });
  if (!r.json || !r.json.ok) throw new Error('upload failed: ' + JSON.stringify(r.json));
  return r.json.file;
}

async function main() {
  // --- login ---
  let r = await req('POST', '/api/login', { json: { username: 'admin', password: PW } });
  step('login ok', r.status === 200 && r.json && r.json.ok, r.json);
  if (r.setCookie) cookie = r.setCookie.split(';')[0];

  // --- upload two files: one public, one private ---
  const pubFile = await uploadFile('batch1-public.txt', 'hello batch1 public', 'public');
  step('upload public file', !!pubFile.id, pubFile);
  const privFile = await uploadFile('batch1-private.txt', 'hello batch1 private', 'private');
  step('upload private file', !!privFile.id, privFile);

  // --- share creation: maxDownloads mapping ---
  r = await authedReq('POST', `/api/files/${pubFile.id}/share`, { json: { maxDownloads: 2 } });
  step('share maxDownloads=2', r.status === 200 && r.json && r.json.ok
    && r.json.maxDownloads === 2 && r.json.burn === false
    && r.json.usedDownloads === 0 && PICKUP_RE.test(r.json.pickupCode || '')
    && r.json.code === null, r.json);
  const share2 = r.json;

  r = await authedReq('POST', `/api/files/${privFile.id}/share`, { json: { burn: true } });
  step('share burn:true -> maxDownloads=1', r.status === 200 && r.json && r.json.ok
    && r.json.maxDownloads === 1 && r.json.burn === true
    && PICKUP_RE.test(r.json.pickupCode || ''), r.json);
  const burnShare = r.json;

  r = await authedReq('POST', `/api/files/${pubFile.id}/share`, { json: { maxDownloads: 5 } });
  step('share maxDownloads=5 -> burn false', r.status === 200 && r.json
    && r.json.maxDownloads === 5 && r.json.burn === false, r.json);
  const share5 = r.json;

  r = await authedReq('POST', `/api/files/${pubFile.id}/share`, { json: { maxDownloads: 1 } });
  step('share maxDownloads=1 -> burn true', r.status === 200 && r.json
    && r.json.maxDownloads === 1 && r.json.burn === true, r.json);

  r = await authedReq('POST', `/api/files/${pubFile.id}/share`, { json: { maxDownloads: 0 } });
  step('share maxDownloads=0 -> burn false (unlimited)', r.status === 200 && r.json
    && r.json.maxDownloads === 0 && r.json.burn === false, r.json);

  // --- GET share: all fields present ---
  r = await authedReq('GET', `/api/files/${pubFile.id}/share`);
  step('GET share has all fields', r.status === 200 && r.json && r.json.share
    && typeof r.json.share.token === 'string'
    && 'code' in r.json.share && 'burn' in r.json.share
    && 'pickupCode' in r.json.share && 'maxDownloads' in r.json.share
    && 'usedDownloads' in r.json.share, r.json);

  // --- update share: pickupCode retained, code updated ---
  const codeBefore = share5.pickupCode;
  r = await authedReq('POST', `/api/files/${pubFile.id}/share`, { json: { code: '1234', maxDownloads: 5 } });
  step('update share retains pickupCode', r.status === 200 && r.json
    && r.json.pickupCode === codeBefore && r.json.code === '1234'
    && r.json.maxDownloads === 5, r.json);

  // --- GET /api/share/:token: share field, no plaintext code ---
  r = await req('GET', `/api/share/${share5.token}?code=1234`);
  step('GET /api/share has share field, no code', r.status === 200 && r.json && r.json.share
    && r.json.share.maxDownloads === 5 && r.json.share.usedDownloads === 0
    && typeof r.json.share.pickupCode === 'string' && 'burn' in r.json.share
    && !('code' in r.json.share), r.json);

  // --- pickup: valid code (upper + lower) ---
  // NOTE: pubFile share now has code '1234' (set above), so needCode is true.
  r = await req('GET', `/api/pickup/${share2.pickupCode}`);
  step('pickup valid (upper, needCode true)', r.status === 200 && r.json && r.json.ok
    && r.json.token === share2.token && r.json.needCode === true, r.json);
  r = await req('GET', `/api/pickup/${share2.pickupCode.toLowerCase()}`);
  step('pickup valid (lower, case-insensitive)', r.status === 200 && r.json && r.json.ok
    && r.json.token === share2.token, r.json);
  // burnShare (private file) has no extraction code -> needCode false
  r = await req('GET', `/api/pickup/${burnShare.pickupCode}`);
  step('pickup valid, no code -> needCode false', r.status === 200 && r.json && r.json.ok
    && r.json.token === burnShare.token && r.json.needCode === false, r.json);

  // --- pickup: invalid code 404 ---
  r = await req('GET', '/api/pickup/ZZZZZ');
  step('pickup invalid 404', r.status === 404 && r.json && r.json.ok === false, { status: r.status, body: r.json });

  // --- pickup: rate limit (fresh IP, 5 misses then 429) ---
  const badIp = { 'X-Forwarded-For': '203.0.113.50' };
  let rlOk = true;
  for (let i = 0; i < 5; i++) {
    const rr = await req('GET', '/api/pickup/AAAAA', { headers: badIp });
    if (rr.status !== 404) rlOk = false;
  }
  r = await req('GET', '/api/pickup/AAAAA', { headers: badIp });
  step('pickup rate limit: 6th attempt 429', rlOk && r.status === 429, { status: r.status, body: r.json });
  // valid code from a DIFFERENT ip still works (rate limit is per-ip)
  r = await req('GET', `/api/pickup/${share2.pickupCode}`, { headers: { 'X-Forwarded-For': '203.0.113.51' } });
  step('pickup valid from another ip after blocks', r.status === 200 && r.json && r.json.ok, { status: r.status, body: r.json });

  // --- download decrement: maxDownloads=2 (public file, share2) ---
  // reset share2 to maxDownloads=2 (it was overwritten to 5 then 0 by later creates; re-create)
  // NOTE: the share now has code '1234' (set above), so download URLs must pass &code=1234.
  r = await authedReq('POST', `/api/files/${pubFile.id}/share`, { json: { maxDownloads: 2 } });
  const s2 = r.json;
  step('re-create share maxDownloads=2', r.status === 200 && s2.maxDownloads === 2, r.json);
  r = await req('GET', `/f/${pubFile.id}?share=${s2.token}&code=1234&download=1`);
  step('download 1/2 ok', r.status === 200, { status: r.status });
  r = await authedReq('GET', `/api/files/${pubFile.id}/share`);
  step('usedDownloads=1 after 1st', r.json && r.json.share && r.json.share.usedDownloads === 1, r.json);
  r = await req('GET', `/f/${pubFile.id}?share=${s2.token}&code=1234&download=1`);
  step('download 2/2 ok', r.status === 200, { status: r.status });
  r = await authedReq('GET', `/api/files/${pubFile.id}/share`);
  step('usedDownloads=2 after 2nd', r.json && r.json.share && r.json.share.usedDownloads === 2, r.json);
  r = await req('GET', `/f/${pubFile.id}?share=${s2.token}&code=1234&download=1`);
  step('download 3rd -> 410 Gone', r.status === 410, { status: r.status, body: r.json });
  // preview (no download=1) does NOT decrement
  r = await req('GET', `/f/${pubFile.id}?share=${s2.token}&code=1234`);
  step('preview does not decrement', r.status === 200, { status: r.status });
  r = await authedReq('GET', `/api/files/${pubFile.id}/share`);
  step('usedDownloads still 2 after preview', r.json && r.json.share && r.json.share.usedDownloads === 2, r.json);
  // GET /api/share does NOT decrement
  r = await req('GET', `/api/share/${s2.token}?code=1234`);
  step('GET /api/share does not decrement', r.status === 200, { status: r.status });
  r = await authedReq('GET', `/api/files/${pubFile.id}/share`);
  step('usedDownloads still 2 after share info', r.json && r.json.share && r.json.share.usedDownloads === 2, r.json);

  // --- burn: private file, 1 download then share gone ---
  r = await req('GET', `/f/${privFile.id}?share=${burnShare.token}&download=1`);
  step('burn download ok', r.status === 200, { status: r.status });
  r = await authedReq('GET', `/api/files/${privFile.id}/share`);
  step('burn share deleted after download', r.status === 200 && r.json && r.json.share === null, r.json);

  // --- tokens: CRUD ---
  r = await req('GET', '/api/tokens');
  step('GET /api/tokens unauthed 401', r.status === 401, { status: r.status });
  r = await authedReq('GET', '/api/tokens');
  step('GET /api/tokens empty', r.status === 200 && r.json && r.json.ok && Array.isArray(r.json.tokens) && r.json.tokens.length === 0, r.json);
  r = await authedReq('POST', '/api/tokens', { json: { name: 'test-token', scope: 'upload' } });
  step('POST /api/tokens creates', r.status === 200 && r.json && r.json.ok
    && typeof r.json.token === 'string' && r.json.token.startsWith('rbx_') && r.json.token.length === 36
    && r.json.prefix === r.json.token.slice(0, 8) && r.json.name === 'test-token'
    && r.json.scope === 'upload' && typeof r.json.id === 'string', r.json);
  const tok = r.json;
  r = await authedReq('GET', '/api/tokens');
  step('GET /api/tokens lists 1, no secret', r.status === 200 && r.json && r.json.tokens.length === 1
    && r.json.tokens[0].id === tok.id && r.json.tokens[0].prefix === tok.prefix
    && !('token' in r.json.tokens[0]) && !('tokenHash' in r.json.tokens[0])
    && !('token_hash' in r.json.tokens[0]), r.json);
  r = await authedReq('POST', '/api/tokens', { json: { name: 'all-scope', scope: 'all' } });
  step('POST /api/tokens scope=all', r.status === 200 && r.json && r.json.scope === 'all', r.json);
  const tokAll = r.json;
  r = await authedReq('DELETE', `/api/tokens/${tok.id}`);
  step('DELETE /api/tokens ok', r.status === 200 && r.json && r.json.ok, r.json);
  r = await authedReq('GET', '/api/tokens');
  step('GET /api/tokens after delete has 1', r.status === 200 && r.json && r.json.tokens.length === 1
    && r.json.tokens[0].id === tokAll.id, r.json);
  r = await authedReq('DELETE', '/api/tokens/does-not-exist');
  step('DELETE nonexistent token ok', r.status === 200 && r.json && r.json.ok, r.json);

  console.log(`\n=== Batch 1 live: passed ${passed}, failed ${failed} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
