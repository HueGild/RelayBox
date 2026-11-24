// Batch 1 (v3.1) raw-upload verification (in-process Hono app).
// Builds the app directly with JsonMetaStore + a LocalStorage instance
// standing in for R2 (enabled=true), so the full raw-upload path
// (token auth -> parseBody/raw body -> deps.r2.put -> meta) is exercised
// without real R2 credentials. Run: node test-batch1-raw.js
// NOTE: creates a temp root under ~/workspace/.test-raw/ and removes it after.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './src/core/app.js';
import { JsonMetaStore } from './src/adapters/node/json-meta.js';
import { LocalStorage } from './src/adapters/node/local-storage.js';

const ROOT = path.join(os.homedir(), 'workspace', '.test-raw');
const PW = 'testpass123';
let passed = 0, failed = 0;
function step(name, cond, detail) {
  if (cond) passed++; else { failed++; console.error('FAIL:', name, JSON.stringify(detail)); }
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const dataDir = path.join(ROOT, 'data');
  const filesDir = path.join(ROOT, 'files');
  const r2Dir = path.join(ROOT, 'r2mock');
  const thumbsDir = path.join(ROOT, 'thumbs');
  for (const d of [dataDir, filesDir, r2Dir, thumbsDir]) fs.mkdirSync(d, { recursive: true });

  const meta = new JsonMetaStore(dataDir);
  const local = new LocalStorage(filesDir, thumbsDir);
  const r2mock = new LocalStorage(r2Dir, thumbsDir); // enabled getter returns true
  const deps = {
    meta, local, r2: r2mock,
    config: { uploadPassword: PW, maxUploadSize: 10 * 1024 * 1024 * 1024 },
    getClientIp: () => '127.0.0.1',
  };
  const app = createApp(deps);

  // --- login + create an API token ---
  let r = await app.request('http://test/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PW }),
  });
  let j = await r.json();
  step('login ok', r.status === 200 && j.ok, j);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];

  r = await app.request('http://test/api/tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'raw-test', scope: 'upload' }),
  });
  j = await r.json();
  step('create api token', r.status === 200 && j.ok && j.token && j.token.startsWith('rbx_'), j);
  const token = j.token;
  const authH = { Authorization: 'Bearer ' + token };

  // --- multipart upload (FormData, field name 'file') ---
  const fd = new FormData();
  fd.append('file', new Blob(['hello raw-upload multipart'], { type: 'text/plain' }), 'hello.txt');
  r = await app.request('http://test/api/raw-upload', { method: 'POST', headers: authH, body: fd });
  j = await r.json().catch(() => null);
  step('raw-upload multipart ok', r.status === 200 && j && j.ok && j.file && j.file.name === 'hello.txt'
    && j.file.storage === 'r2' && j.file.visibility === 'public' && typeof j.url === 'string'
    && j.url.endsWith('/f/' + j.file.id), { status: r.status, body: j });
  const fileId1 = j && j.file ? j.file.id : null;
  if (fileId1) {
    const onDisk = fs.existsSync(path.join(r2Dir, j.file.storageKey));
    step('multipart bytes landed in r2 mock', onDisk, j.file.storageKey);
    // file is retrievable via /f/:id (public)
    const rr = await app.request(`http://test/f/${fileId1}`);
    const txt = await rr.text();
    step('uploaded file retrievable', rr.status === 200 && txt === 'hello raw-upload multipart', { status: rr.status, body: txt.slice(0, 40) });
  }

  // --- raw binary upload (curl --data-binary style) ---
  r = await app.request('http://test/api/raw-upload', {
    method: 'POST',
    headers: { ...authH, 'Content-Type': 'application/octet-stream', 'X-Filename': 'binary.bin' },
    body: new Uint8Array([1, 2, 3, 4, 5]),
  });
  j = await r.json().catch(() => null);
  step('raw-upload binary ok', r.status === 200 && j && j.ok && j.file && j.file.name === 'binary.bin'
    && j.file.size === 5, { status: r.status, body: j });

  // --- ?token= query auth + format=text ---
  const fd2 = new FormData();
  fd2.append('file', new Blob(['text format'], { type: 'text/plain' }), 'fmt.txt');
  r = await app.request('http://test/api/raw-upload?token=' + encodeURIComponent(token) + '&format=text', {
    method: 'POST', body: fd2,
  });
  const textUrl = await r.text();
  step('raw-upload ?token + format=text', r.status === 200
    && r.headers.get('content-type') && r.headers.get('content-type').includes('text/plain')
    && /^https?:\/\/[^/]+\/f\/[A-Za-z0-9]+$/.test(textUrl), { status: r.status, body: textUrl });

  // --- visibility=private + folderId ---
  const fd3 = new FormData();
  fd3.append('file', new Blob(['private file'], { type: 'text/plain' }), 'priv.txt');
  r = await app.request('http://test/api/raw-upload?visibility=private', {
    method: 'POST', headers: authH, body: fd3,
  });
  j = await r.json().catch(() => null);
  step('raw-upload visibility=private', r.status === 200 && j && j.ok && j.file.visibility === 'private', { status: r.status, body: j });

  // --- auth failures ---
  r = await app.request('http://test/api/raw-upload', {
    method: 'POST', headers: { Authorization: 'Bearer rbx_00000000000000000000000000000000' },
    body: new Uint8Array([9]),
  });
  step('raw-upload bad token 401', r.status === 401, { status: r.status });
  r = await app.request('http://test/api/raw-upload', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'x.txt' },
    body: new Uint8Array([9]),
  });
  step('raw-upload no token 401', r.status === 401, { status: r.status });

  // --- revoked token 401 ---
  r = await app.request('http://test/api/tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'to-revoke', scope: 'upload' }),
  });
  const j2 = await r.json();
  const tok2 = j2.token, tok2id = j2.id;
  r = await app.request(`http://test/api/tokens/${tok2id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  step('revoke token', r.status === 200, { status: r.status });
  r = await app.request('http://test/api/raw-upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok2, 'Content-Type': 'application/octet-stream', 'X-Filename': 'x.txt' },
    body: new Uint8Array([9]),
  });
  step('raw-upload revoked token 401', r.status === 401, { status: r.status });

  // --- last_used_at updated after a successful upload ---
  r = await app.request('http://test/api/tokens', { headers: { Cookie: cookie } });
  j = await r.json();
  const listed = (j.tokens || []).find((t) => t.prefix === token.slice(0, 8));
  step('token lastUsedAt updated', !!listed && typeof listed.lastUsedAt === 'number' && listed.lastUsedAt > 0, listed);

  // --- 413 on oversize (Content-Length pre-check, raw binary) ---
  const big = new Uint8Array(33 * 1024 * 1024); // 33MB body
  r = await app.request('http://test/api/raw-upload', {
    method: 'POST',
    headers: { ...authH, 'Content-Type': 'application/octet-stream', 'X-Filename': 'big.bin', 'Content-Length': String(big.byteLength) },
    body: big,
  });
  step('raw-upload >32MB 413', r.status === 413, { status: r.status });

  // --- 400 when no file in multipart ---
  const fdEmpty = new FormData();
  fdEmpty.append('note', 'no file here');
  r = await app.request('http://test/api/raw-upload', { method: 'POST', headers: authH, body: fdEmpty });
  step('raw-upload multipart no file 400', r.status === 400, { status: r.status });

  console.log(`\n=== Batch 1 raw-upload: passed ${passed}, failed ${failed} ===`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST CRASH:', e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} process.exit(1); });
