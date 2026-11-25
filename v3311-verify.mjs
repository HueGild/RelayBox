// v3.3.11 verification: publicDomain preview redirect (S3PoolStorage.get allowPublicRedirect
// + /f/:id gating) — full-app test with an in-memory mock S3 endpoint (aws4fetch passes a
// Request object, like v337). No external network.
// Usage: node v3311-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './src/core/app.js';
import { JsonMetaStore } from './src/adapters/node/json-meta.js';
import { R2Storage } from './src/adapters/cf/r2-storage.js';
import { S3PoolStorage } from './src/core/lib/s3-pool.js';

const PW = 'testpass123';
const CDN = 'https://cdn.example.com';
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS:', name); }
  else { failed++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''); }
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

// ================= A. S3PoolStorage.get() allowPublicRedirect (unit) =================
console.log('--- A. S3PoolStorage.get() allowPublicRedirect ---');
{
  const pool = new S3PoolStorage({ id: 'p1', name: 'CDN 池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket', region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST', publicDomain: CDN });
  const r1 = await pool.get('abc123_demo.png', { allowPublicRedirect: true });
  check('A1 publicDomain + allowPublicRedirect -> 302 to CDN', r1.status === 302 && r1.headers.get('location') === CDN + '/abc123_demo.png', r1.headers.get('location'));
  const r2 = await pool.get('abc123_demo.png', { allowPublicRedirect: false });
  check('A2 allowPublicRedirect=false -> 302 to presigned S3 URL (not CDN)', r2.status === 302 && r2.headers.get('location').includes('127.0.0.1:1') && !r2.headers.get('location').includes('cdn.example.com'), r2.headers.get('location'));
  const r3 = await pool.get('abc123_demo.png', {});
  check('A3 no flag -> 302 to presigned S3 URL (default, no redirect)', r3.status === 302 && r3.headers.get('location').includes('127.0.0.1:1'), r3.headers.get('location'));
  const poolNoDomain = new S3PoolStorage({ id: 'p2', name: '无域名池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket', region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST' });
  const r4 = await poolNoDomain.get('abc123_demo.png', { allowPublicRedirect: true });
  check('A4 no publicDomain + allowPublicRedirect -> falls through to presigned', r4.status === 302 && r4.headers.get('location').includes('127.0.0.1:1'), r4.headers.get('location'));
  check('A5 publicUrl encodes per-segment (spaces + Chinese)', pool.publicUrl('id_中文 文件.png') === CDN + '/id_%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.png', pool.publicUrl('id_中文 文件.png'));
  check('A6 publicUrl empty without publicDomain', poolNoDomain.publicUrl('x.png') === '', poolNoDomain.publicUrl('x.png'));
  check('A7 publicDomain trailing slash trimmed', new S3PoolStorage({ publicDomain: CDN + '/' }).publicDomain === CDN, new S3PoolStorage({ publicDomain: CDN + '/' }).publicDomain);
}

// ================= B. /f/:id gating through the full app =================
console.log('\n--- B. /f/:id publicDomain gating (full app) ---');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-v3311-'));
const mockR2 = new MockR2();
const deps = buildDeps({ root, mockR2 });
const app = createApp(deps);
const cookie = await login(app);
const H = { 'Cookie': cookie, 'X-Upload-Password': PW };
const imgBytes = fs.readFileSync('/home/hatch/relaybox-test-r7/test-img.png');

// create S3 pool WITH publicDomain
const poolRes = await req(app, 'POST', '/api/pools', { headers: H, json: {
  name: 'CDN 外部池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket',
  region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST', publicDomain: CDN,
} });
const cdnPoolId = poolRes.json && (poolRes.json.pool && poolRes.json.pool.id || poolRes.json.id);
check('B0 S3 pool with publicDomain created', !!cdnPoolId, poolRes.json);
const poolsList = await req(app, 'GET', '/api/pools', { headers: H });
const cdnPool = (poolsList.json.pools || []).find(p => p.id === cdnPoolId);
check('B0b GET /api/pools returns publicDomain', cdnPool && cdnPool.publicDomain === CDN, cdnPool);

// public image -> migrate to CDN pool -> GET /f/:id should 302 to CDN
const pubImg = await uploadProxy(app, H, 'v3311-public.png', imgBytes, '&visibility=public');
const mig1 = await req(app, 'POST', `/api/files/${pubImg.id}/migrate`, { headers: H, json: { targetPoolId: cdnPoolId } });
check('B1 public image migrated to CDN pool', mig1.status === 200 && mig1.json.ok && mig1.json.migrated === true, mig1.json);
const rec1 = await deps.meta.getFile(pubImg.id);
check('B1b metadata poolId=CDN pool', rec1 && rec1.poolId === cdnPoolId, rec1 && rec1.poolId);
const f1 = await req(app, 'GET', `/f/${pubImg.id}`, {});
check('B2 public preview GET /f/:id -> 302 to CDN publicDomain', f1.status === 302 && f1.headers.get('location') === CDN + '/' + encodeURIComponent(rec1.storageKey), f1.headers.get('location'));
const f1dl = await req(app, 'GET', `/f/${pubImg.id}?download=1`, {});
check('B3 public download=1 -> 302 presigned (no CDN redirect, forceDownload)', f1dl.status === 302 && f1dl.headers.get('location').includes('127.0.0.1:1') && !f1dl.headers.get('location').includes('cdn.example.com'), f1dl.headers.get('location'));
const sh1 = await req(app, 'POST', `/api/files/${pubImg.id}/share`, { headers: H, json: { maxDownloads: 5 } });
const f1share = await req(app, 'GET', `/f/${pubImg.id}?share=${sh1.json.token}`, {});
check('B4 limited share GET /f/:id?share=token -> 302 presigned (no CDN redirect)', f1share.status === 302 && f1share.headers.get('location').includes('127.0.0.1:1') && !f1share.headers.get('location').includes('cdn.example.com'), f1share.headers.get('location'));
const f1shareDl = await req(app, 'GET', `/f/${pubImg.id}?share=${sh1.json.token}&download=1`, {});
check('B5 limited share download=1 -> 302 presigned (counted)', f1shareDl.status === 302 && f1shareDl.headers.get('location').includes('127.0.0.1:1'), f1shareDl.headers.get('location'));
const sharesAfterDl = await req(app, 'GET', '/api/shares', { headers: H });
const eSh1 = (sharesAfterDl.json.shares || []).find(s => s.token === sh1.json.token);
check('B5b limited share usedDownloads=1 after download', eSh1 && eSh1.usedDownloads === 1 && eSh1.remainingDownloads === 4, eSh1);

// private image in CDN pool -> no redirect
const privImg = await uploadProxy(app, H, 'v3311-private.png', imgBytes, '&visibility=private');
const mig2 = await req(app, 'POST', `/api/files/${privImg.id}/migrate`, { headers: H, json: { targetPoolId: cdnPoolId } });
check('B6 private image migrated to CDN pool', mig2.status === 200 && mig2.json.ok, mig2.json);
const f2 = await req(app, 'GET', `/f/${privImg.id}`, { headers: H });
check('B7 private GET /f/:id -> 302 presigned (no CDN redirect, isPrivate)', f2.status === 302 && f2.headers.get('location').includes('127.0.0.1:1') && !f2.headers.get('location').includes('cdn.example.com'), f2.headers.get('location'));
const f2guest = await req(app, 'GET', `/f/${privImg.id}`, {});
check('B8 private GET /f/:id guest -> 403 (private, no share)', f2guest.status === 403, f2guest.status);

// S3 pool WITHOUT publicDomain -> presigned, not CDN
const poolRes2 = await req(app, 'POST', '/api/pools', { headers: H, json: {
  name: '普通外部池', endpoint: 'http://127.0.0.1:1/', bucket: 'test-bucket',
  region: 'auto', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETTEST',
} });
const plainPoolId = poolRes2.json && (poolRes2.json.pool && poolRes2.json.pool.id || poolRes2.json.id);
check('B9 S3 pool without publicDomain created', !!plainPoolId, poolRes2.json);
const pubImg2 = await uploadProxy(app, H, 'v3311-public2.png', imgBytes, '&visibility=public');
const mig3 = await req(app, 'POST', `/api/files/${pubImg2.id}/migrate`, { headers: H, json: { targetPoolId: plainPoolId } });
check('B10 public image migrated to plain pool', mig3.status === 200 && mig3.json.ok, mig3.json);
const f3 = await req(app, 'GET', `/f/${pubImg2.id}`, {});
check('B11 plain pool GET /f/:id -> 302 to presigned S3 URL (not CDN)', f3.status === 302 && f3.headers.get('location').includes('127.0.0.1:1') && !f3.headers.get('location').includes('cdn.example.com'), f3.headers.get('location'));

// builtin R2 public file -> no redirect (R2Storage has no publicDomain)
const pubImg3 = await uploadProxy(app, H, 'v3311-public3.png', imgBytes, '&visibility=public');
const f4 = await req(app, 'GET', `/f/${pubImg3.id}`, {});
check('B12 builtin R2 public GET /f/:id -> 200 (no publicDomain)', f4.status === 200, f4.status);

// ================= C. r19 contracts preserved =================
console.log('\n--- C. r19 contracts preserved ---');
const sharesRes = await req(app, 'GET', '/api/shares', { headers: H });
check('C1 GET /api/shares still works', sharesRes.status === 200 && sharesRes.json.ok, sharesRes.status);
const batchRes = await req(app, 'POST', '/api/files/batch', { headers: H, json: { action: 'visibility', ids: [pubImg3.id], visibility: 'private' } });
check('C2 POST /api/files/batch still works', batchRes.status === 200 && batchRes.json.count === 1, batchRes.json);
const batchUnauth = await req(app, 'POST', '/api/files/batch', { json: { action: 'trash', ids: [pubImg3.id] } });
check('C3 POST /api/files/batch unauthed -> 401', batchUnauth.status === 401, batchUnauth.status);
const singleShare = await req(app, 'POST', `/api/files/${pubImg3.id}/share`, { headers: H, json: {} });
check('C4 POST /api/files/:id/share still works', singleShare.status === 200 && !!singleShare.json.token, singleShare.json);

globalThis.fetch = realFetch;
console.log(`\n=== v3.3.11 verify: passed ${passed}, failed ${failed} ===`);
if (failed) process.exitCode = 1;
