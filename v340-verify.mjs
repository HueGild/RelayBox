// v3.4.0 verification: pure-CF regression after the VPS/Node cleanup.
// Full-app test with D1MetaStore backed by a node:sqlite mock D1 binding
// (D1 is SQLite; schema.sql is the fresh-deploy baseline, already includes
// migrations 001-005) + in-memory mock R2 (builtin) + mock S3 endpoint
// (external pools, aws4fetch passes a Request object). No external network.
// Replaces the Node-adapter suites (v3310/v3311/test-batch1-raw) that died
// with src/adapters/node/.
// Usage: node v340-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './src/core/app.js';
import { D1MetaStore } from './src/adapters/cf/d1-meta.js';
import { R2Storage } from './src/adapters/cf/r2-storage.js';
import { S3PoolStorage } from './src/core/lib/s3-pool.js';

const PW = 'testpass123';
const CDN = 'https://cdn.example.com';
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS:', name); }
  else { failed++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''); }
}

// ---- mock D1 binding on node:sqlite ----
class MockD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    const schemaSql = fs.readFileSync(new URL('./src/schema.sql', import.meta.url), 'utf8');
    this.db.exec(schemaSql);
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const wrap = (params) => ({
      run: async () => {
        const r = stmt.run(...params);
        return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
      },
      all: async () => ({ results: stmt.all(...params) }),
      first: async () => {
        const row = stmt.get(...params);
        return row === undefined ? null : row;
      },
    });
    return {
      bind: (...params) => wrap(params),
      run: async (...params) => wrap(params).run(),
      all: async (...params) => wrap(params).all(),
      first: async (...params) => wrap(params).first(),
    };
  }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

// ---- in-memory mock R2 bucket (builtin) ----
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

// ---- in-memory mock S3 endpoint (external pools) ----
const s3store = new Map();
function s3KeyOf(url) {
  return decodeURIComponent(url.pathname.slice('/test-bucket/'.length));
}
async function mockS3Fetch(input, init = {}) {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const key = s3KeyOf(url);
  if (method === 'PUT') {
    const bytes = new Uint8Array(await req.arrayBuffer());
    s3store.set(key, bytes);
    return new Response(null, { status: 200, headers: { ETag: '"mock-etag"' } });
  }
  if (method === 'HEAD') {
    const b = s3store.get(key);
    if (!b) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { 'Content-Length': String(b.length), ETag: '"mock-etag"' } });
  }
  if (method === 'GET') {
    const b = s3store.get(key);
    if (!b) return new Response(null, { status: 404 });
    return new Response(b, { status: 200, headers: { 'Content-Length': String(b.length) } });
  }
  if (method === 'DELETE') {
    s3store.delete(key);
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 400 });
}
const realFetch = globalThis.fetch;
globalThis.fetch = mockS3Fetch;

function buildDeps({ mockR2 }) {
  const db = new MockD1();
  const r2 = new R2Storage({ binding: mockR2, bucket: 'test-bucket', accountId: '', accessKeyId: '', secretAccessKey: '' });
  const meta = new D1MetaStore(db, r2);
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
    _mockD1: db,
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

// ================= setup =================
const mockR2 = new MockR2();
const deps = buildDeps({ mockR2 });
const app = createApp(deps);
const imgBytes = fs.readFileSync('/home/hatch/relaybox-test-r7/test-img.png');

// ================= A. D1 schema (fresh baseline) =================
console.log('--- A. D1 schema ---');
{
  const db = deps._mockD1.db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check('A1 11 tables present', ['files', 'folders', 'shares', 'api_tokens', 'drop_links', 'sessions', 'announcement', 'login_attempts', 'chunk_uploads', 'settings', 'storage_pools'].every((t) => tables.includes(t)), tables);
  const cols = db.prepare("SELECT name FROM pragma_table_info('files')").all().map((r) => r.name);
  check('A2 files has deleted_at + storage_key + pool_id', ['deleted_at', 'storage_key', 'pool_id'].every((c) => cols.includes(c)), cols);
  const shareCols = db.prepare("SELECT name FROM pragma_table_info('shares')").all().map((r) => r.name);
  check('A3 shares has max_downloads/used_downloads/pickup_code', ['max_downloads', 'used_downloads', 'pickup_code'].every((c) => shareCols.includes(c)), shareCols);
}

// ================= B. Auth =================
console.log('\n--- B. Auth ---');
{
  const bad = await req(app, 'POST', '/api/login', { json: { username: 'admin', password: 'wrong' } });
  check('B1 wrong password -> 401', bad.status === 401, bad.status);
  const ok = await req(app, 'POST', '/api/login', { json: { username: 'admin', password: PW } });
  check('B2 correct password -> 200 + set-cookie', ok.status === 200 && (ok.headers.get('set-cookie') || '').includes('='), ok.status);
}
const cookie = await login(app);
const H = { 'Cookie': cookie, 'X-Upload-Password': PW };

// ================= C. Upload / list / search / folders =================
console.log('\n--- C. Upload / list / search / folders ---');
const pubImg = await uploadProxy(app, H, 'v340-public.png', imgBytes, '&visibility=public');
check('C1 upload-proxy public image', !!pubImg.id && pubImg.visibility === 'public', pubImg);
const privTxt = await uploadProxy(app, H, 'v340-private.txt', new TextEncoder().encode('hello v340'), '&visibility=private');
check('C2 upload-proxy private text', !!privTxt.id && privTxt.visibility === 'private', privTxt);
const listRes = await req(app, 'GET', '/api/files', { headers: H });
check('C3 GET /api/files authed lists both', listRes.status === 200 && (listRes.json.files || []).length === 2, (listRes.json.files || []).length);
const listGuest = await req(app, 'GET', '/api/files', {});
check('C4 GET /api/files guest lists only public', listGuest.status === 200 && (listGuest.json.files || []).length === 1, (listGuest.json.files || []).length);
const searchRes = await req(app, 'GET', '/api/search?q=v340-public', { headers: H });
check('C5 GET /api/search finds the image', searchRes.status === 200 && (searchRes.json.files || []).some((f) => f.id === pubImg.id), searchRes.json);
const folderRes = await req(app, 'POST', '/api/folders', { headers: H, json: { name: 'v340 目录' } });
const folderId = folderRes.json && (folderRes.json.folder && folderRes.json.folder.id || folderRes.json.id);
check('C6 create folder', !!folderId, folderRes.json);
const moveRes = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'move', ids: [pubImg.id], folderId } });
check('C7 batch move into folder', moveRes.status === 200 && moveRes.json.count === 1, moveRes.json);
const folderList = await req(app, 'GET', `/api/files?folderId=${folderId}`, { headers: H });
check('C8 folder listing shows the moved file', folderList.status === 200 && (folderList.json.files || []).some((f) => f.id === pubImg.id), folderList.json);
check('C9 folder path breadcrumb', Array.isArray(folderList.json.path) && folderList.json.path.length === 2 && folderList.json.path[1].id === folderId, folderList.json.path);

// ================= D. Shares (r19 contracts) =================
console.log('\n--- D. Shares ---');
const sh = await req(app, 'POST', `/api/files/${pubImg.id}/share`, { headers: H, json: { maxDownloads: 5 } });
check('D1 create limited share (maxDownloads=5)', sh.status === 200 && !!sh.json.token && sh.json.pickupCode, sh.json);
const sharesRes = await req(app, 'GET', '/api/shares', { headers: H });
check('D2 GET /api/shares lists it active', sharesRes.status === 200 && (sharesRes.json.shares || []).some((s) => s.token === sh.json.token && s.status === 'active'), sharesRes.json);
const pickup = await req(app, 'GET', `/api/pickup/${sh.json.pickupCode}`, {});
check('D3 GET /api/pickup/:code resolves token', pickup.status === 200 && pickup.json.token === sh.json.token, pickup.json);
const dl = await req(app, 'GET', `/f/${pubImg.id}?share=${sh.json.token}&download=1`, {});
check('D4 share download -> 200 (builtin R2 stream)', dl.status === 200, dl.status);
const sharesAfter = await req(app, 'GET', '/api/shares', { headers: H });
const eSh = (sharesAfter.json.shares || []).find((s) => s.token === sh.json.token);
check('D5 usedDownloads=1 after download', eSh && eSh.usedDownloads === 1 && eSh.remainingDownloads === 4, eSh);
const burn = await req(app, 'POST', `/api/files/${privTxt.id}/share`, { headers: H, json: { maxDownloads: 1 } });
check('D6 maxDownloads=1 is burn-after-reading', burn.status === 200 && burn.json.burn === true, burn.json);
const delShare = await req(app, 'DELETE', `/api/shares/${sh.json.token}`, { headers: H });
check('D7 DELETE /api/shares/:token revokes', delShare.status === 200 && delShare.json.ok, delShare.json);

// ================= E. Batch + trash =================
console.log('\n--- E. Batch + trash ---');
const m1 = await uploadProxy(app, H, 'v340-m1.txt', new TextEncoder().encode('m1'), '&visibility=public');
const m2 = await uploadProxy(app, H, 'v340-m2.txt', new TextEncoder().encode('m2'), '&visibility=public');
const m3 = await uploadProxy(app, H, 'v340-m3.txt', new TextEncoder().encode('m3'), '&visibility=public');
const visBatch = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'visibility', ids: [m1.id, m2.id], visibility: 'private' } });
check('E1 batch visibility (2 files)', visBatch.status === 200 && visBatch.json.count === 2, visBatch.json);
const trashBatch = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'trash', ids: [m1.id, m2.id, 'nonexistent-id'] } });
check('E2 batch trash (2 ok + 1 notFound)', trashBatch.status === 200 && trashBatch.json.count === 2 && (trashBatch.json.notFoundIds || []).includes('nonexistent-id'), trashBatch.json);
const trashList = await req(app, 'GET', '/api/trash', { headers: H });
check('E3 GET /api/trash lists 2', trashList.status === 200 && (trashList.json.files || []).length === 2, (trashList.json.files || []).length);
const restore = await req(app, 'POST', `/api/trash/${m1.id}/restore`, { headers: H, json: {} });
check('E4 restore one file from trash', restore.status === 200 && restore.json.ok, restore.json);
const purge = await req(app, 'DELETE', `/api/trash/${m2.id}`, { headers: H });
check('E5 purge one file from trash', purge.status === 200 && purge.json.ok, purge.json);
const batchUnauth = await req(app, 'POST', '/api/files/batch', { json: { action: 'trash', ids: [m3.id] } });
check('E6 batch unauthed -> 401', batchUnauth.status === 401, batchUnauth.status);
const batchOver = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'trash', ids: Array.from({ length: 501 }, (_, i) => 'x' + i) } });
check('E7 batch >500 ids -> 400', batchOver.status === 400, batchOver.status);

// ================= F. D1 batch chunking (>80 ids) =================
console.log('\n--- F. D1 batch chunking (>80 ids) ---');
{
  const ids = [];
  for (let i = 0; i < 95; i++) {
    const f = await uploadProxy(app, H, `v340-bulk-${i}.txt`, new TextEncoder().encode('b' + i), '&visibility=public');
    ids.push(f.id);
  }
  const bigBatch = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'visibility', ids, visibility: 'private' } });
  check('F1 batch visibility 95 ids (chunked IN, db.batch)', bigBatch.status === 200 && bigBatch.json.count === 95, bigBatch.json);
  const bigTrash = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'trash', ids } });
  check('F2 batch trash 95 ids', bigTrash.status === 200 && bigTrash.json.count === 95, bigTrash.json);
}

// ================= G. S3PoolStorage.get() allowPublicRedirect (unit) =================
console.log('\n--- G. S3PoolStorage.get() allowPublicRedirect ---');
{
  const pool = new S3PoolStorage({ id: 'p1', name: 'CDN 池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket', region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST', publicDomain: CDN });
  const r1 = await pool.get('abc123_demo.png', { allowPublicRedirect: true });
  check('G1 publicDomain + allowPublicRedirect -> 302 to CDN', r1.status === 302 && r1.headers.get('location') === CDN + '/abc123_demo.png', r1.headers.get('location'));
  const r2 = await pool.get('abc123_demo.png', { allowPublicRedirect: false });
  check('G2 allowPublicRedirect=false -> 302 presigned (not CDN)', r2.status === 302 && r2.headers.get('location').includes('127.0.0.1:1') && !r2.headers.get('location').includes('cdn.example.com'), r2.headers.get('location'));
  const poolNoDomain = new S3PoolStorage({ id: 'p2', name: '无域名池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket', region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST' });
  const r4 = await poolNoDomain.get('abc123_demo.png', { allowPublicRedirect: true });
  check('G3 no publicDomain + allowPublicRedirect -> falls through to presigned', r4.status === 302 && r4.headers.get('location').includes('127.0.0.1:1'), r4.headers.get('location'));
  check('G4 publicUrl encodes per-segment (spaces + Chinese)', pool.publicUrl('id_中文 文件.png') === CDN + '/id_%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png', pool.publicUrl('id_中文 文件.png'));
}

// ================= H. /f/:id publicDomain gating (full app, D1) =================
console.log('\n--- H. /f/:id publicDomain gating (full app) ---');
const poolRes = await req(app, 'POST', '/api/pools', { headers: H, json: {
  name: 'CDN 外部池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket',
  region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST', publicDomain: CDN,
} });
const cdnPoolId = poolRes.json && (poolRes.json.pool && poolRes.json.pool.id || poolRes.json.id);
check('H0 S3 pool with publicDomain created', !!cdnPoolId, poolRes.json);
const pubImg2 = await uploadProxy(app, H, 'v340-cdn.png', imgBytes, '&visibility=public');
const mig1 = await req(app, 'POST', `/api/files/${pubImg2.id}/migrate`, { headers: H, json: { targetPoolId: cdnPoolId } });
check('H1 public image migrated to CDN pool', mig1.status === 200 && mig1.json.ok && mig1.json.migrated === true, mig1.json);
const rec1 = await deps.meta.getFile(pubImg2.id);
check('H1b metadata poolId=CDN pool', rec1 && rec1.poolId === cdnPoolId, rec1 && rec1.poolId);
const f1 = await req(app, 'GET', `/f/${pubImg2.id}`, {});
check('H2 public preview GET /f/:id -> 302 to CDN publicDomain', f1.status === 302 && f1.headers.get('location') === CDN + '/' + encodeURIComponent(rec1.storageKey), f1.headers.get('location'));
const f1dl = await req(app, 'GET', `/f/${pubImg2.id}?download=1`, {});
check('H3 public download=1 -> 302 presigned (no CDN redirect)', f1dl.status === 302 && f1dl.headers.get('location').includes('127.0.0.1:1') && !f1dl.headers.get('location').includes('cdn.example.com'), f1dl.headers.get('location'));
const privImg = await uploadProxy(app, H, 'v340-cdn-priv.png', imgBytes, '&visibility=private');
const mig2 = await req(app, 'POST', `/api/files/${privImg.id}/migrate`, { headers: H, json: { targetPoolId: cdnPoolId } });
check('H4 private image migrated to CDN pool', mig2.status === 200 && mig2.json.ok, mig2.json);
const f2guest = await req(app, 'GET', `/f/${privImg.id}`, {});
check('H5 private GET /f/:id guest -> 403', f2guest.status === 403, f2guest.status);

globalThis.fetch = realFetch;
console.log(`\n=== v3.4.0 verify (D1): passed ${passed}, failed ${failed} ===`);
if (failed) process.exitCode = 1;
