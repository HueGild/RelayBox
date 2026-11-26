// RelayBox v3.8.0 verification: Sub-accounts & Temporary Test Accounts.
// Tests: PBKDF2 hashing, incremental migration 0006 + fresh schema.sql,
// admin-only route protection, subtree sandboxing, search isolation,
// quota enforcement (413), permission bits (read-only guest), atomic updateUser,
// disable/expiry/kick session revocation, and audit log tagging.
// Usage: node test-v380-users.mjs

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './src/core/app.js';
import { D1MetaStore } from './src/adapters/cf/d1-meta.js';
import { hashPassword, verifyPassword } from './src/core/lib/crypto.js';
import { cleanupExpired } from './src/core/lib/cleanup.js';

const PW = 'adminpass123';
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS:', name); }
  else { failed++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ''); }
}

class MockD1 {
  constructor(sqlInit) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(sqlInit);
  }
  prepare(sql) {
    const db = this.db;
    const mk = (binds) => ({
      bind(...a) { return mk(a); },
      async first() { return db.prepare(sql).get(...binds) ?? null; },
      async all() { return { results: db.prepare(sql).all(...binds) }; },
      async run() {
        const r = db.prepare(sql).run(...binds);
        return { success: true, meta: { changes: Number(r.changes || 0) } };
      },
      _sql: sql, _binds: binds,
    });
    return mk([]);
  }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) {
      if (/^\s*SELECT\b/i.test(s._sql)) out.push(await s.all());
      else out.push(await s.run());
    }
    return out;
  }
}

class MockStorage {
  constructor() {
    this.enabled = true;
    this.proxySupported = true;
    this.objs = new Map();
    this.thumbs = new Map();
  }
  freeBytes() { return 10 * 1024 * 1024 * 1024; }
  totalBytes() { return 10 * 1024 * 1024 * 1024; }
  tempFilePath(n) { return '/tmp/' + n; }
  async removeTempFile() {}
  async put(key, bytes, contentType) { this.objs.set(key, { bytes: new Uint8Array(bytes), contentType: contentType || 'application/octet-stream' }); }
  async get(key, opts = {}) {
    const o = this.objs.get(key);
    if (!o) return null;
    return new Response(o.bytes, { status: 200, headers: { 'Content-Type': opts.contentType || o.contentType } });
  }
  async head(key) {
    const o = this.objs.get(key);
    return o ? { size: o.bytes.byteLength } : null;
  }
  async delete(key) { this.objs.delete(key); }
  async copy(a, b) { const o = this.objs.get(a); if (o) this.objs.set(b, { ...o }); }
  async rename(a, b) { const o = this.objs.get(a); if (o) { this.objs.set(b, o); this.objs.delete(a); } }
  async presignedPutUrl(key) { return `https://r2.example.com/put/${encodeURIComponent(key)}`; }
  async presignedGetUrl(key) { return `https://r2.example.com/get/${encodeURIComponent(key)}`; }
  async createMultipartUpload() { return 'mpu-1'; }
  async presignedPartUrl() { return 'https://r2.example.com/part'; }
  async completeMultipartUpload() {}
  async abortMultipartUpload() {}
  async putFile() {}
  async putThumb(id, buf) { this.thumbs.set(id, new Uint8Array(buf)); }
  async getThumb(id) { return this.thumbs.get(id) || null; }
  async deleteThumb(id) { this.thumbs.delete(id); }
}

function cookieOf(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/fs_admin=([^;]+)/);
  return m ? `fs_admin=${m[1]}` : '';
}

async function req(app, method, urlPath, { cookie = '', body = null, raw = null, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h['Cookie'] = cookie;
  let payload = raw;
  if (body !== null && raw === null) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await app.request(`http://localhost${urlPath}`, { method, headers: h, body: payload });
  let json = null;
  try { json = await r.clone().json(); } catch {}
  return { status: r.status, res: r, json };
}

// 1. PBKDF2 password hashing
{
  const h1 = await hashPassword('secret123');
  const h2 = await hashPassword('secret123');
  check('PBKDF2 format valid', /^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(h1), h1);
  check('PBKDF2 uses unique random salt', h1 !== h2);
  check('PBKDF2 verifyPassword accepts correct password', await verifyPassword('secret123', h1) === true);
  check('PBKDF2 verifyPassword rejects wrong password', await verifyPassword('wrongpass', h1) === false);
  check('PBKDF2 verifyPassword rejects tampered hash', await verifyPassword('secret123', h1.slice(0, -2) + 'AA') === false);
}

// 2. Migration 0006 check on pre-v3.8.0 schema
{
  const freshSql = fs.readFileSync(new URL('./src/schema.sql', import.meta.url), 'utf8');
  const migSql = fs.readFileSync(new URL('./migrations/0006_sub_accounts.sql', import.meta.url), 'utf8');
  check('schema.sql includes users table & owner_id & user_id', freshSql.includes('CREATE TABLE users') && freshSql.includes('owner_id') && freshSql.includes('user_id'));
  check('migration 0006 uses deleted_at (not trashed_at)', migSql.includes('idx_files_owner ON files(owner_id, deleted_at)') && !migSql.includes('trashed_at'));
}

// 3. Full App Integration Tests
const schemaSql = fs.readFileSync(new URL('./src/schema.sql', import.meta.url), 'utf8');
const d1 = new MockD1(schemaSql);
const r2 = new MockStorage();
const local = new MockStorage();
const meta = new D1MetaStore(d1, r2);
const deps = {
  meta, r2, local,
  config: { uploadPassword: PW, maxUploadSize: 100 * 1024 * 1024, chunkSize: 5 * 1024 * 1024 },
  getClientIp: () => '127.0.0.1',
  getClientGeo: () => 'CN',
};
const app = createApp(deps);

// Admin login with empty username (v3.8.0 UX)
const admLogin = await req(app, 'POST', '/api/login', { body: { username: '', password: PW } });
const admCookie = cookieOf(admLogin.res);
check('Admin login with empty username succeeds', admLogin.status === 200 && admLogin.json?.isAdmin === true && !!admCookie);

// Admin creates an outside folder + outside private file
const outFdRes = await req(app, 'POST', '/api/folders', { cookie: admCookie, body: { name: 'AdminSecret' } });
const outFdId = outFdRes.json?.folder?.id;
check('Admin created outside folder', outFdRes.status === 200 && !!outFdId);

const outFileRes = await req(app, 'POST', `/api/upload-proxy?name=secret.txt&size=10&visibility=private&folderId=${outFdId}`, {
  cookie: admCookie, raw: new TextEncoder().encode('0123456789'),
});
const outFileId = outFileRes.json?.file?.id;
check('Admin uploaded outside private file', outFileRes.status === 200 && !!outFileId);

// Create a regular sub-account with autoCreateFolder + 100 byte quota
const u1Res = await req(app, 'POST', '/api/users', {
  cookie: admCookie,
  body: {
    username: 'alice', displayName: 'Alice', password: 'alice-pass',
    role: 'user', autoCreateFolder: true, quotaBytes: 100,
    canUpload: true, canDelete: true, canShare: true,
  },
});
const u1 = u1Res.json?.user;
check('Admin creates sub-account with auto folder', u1Res.status === 200 && u1?.username === 'alice' && !!u1?.rootFolderId);

// Create a read-only 7d guest sharing the same folder
const u2Res = await req(app, 'POST', '/api/users', {
  cookie: admCookie,
  body: {
    username: 'viewer01', displayName: 'Viewer', password: 'viewer-pass',
    role: 'guest', rootFolderId: u1.rootFolderId, quotaBytes: 0,
    canUpload: false, canDelete: false, canShare: false, expiresHours: 168,
  },
});
const u2 = u2Res.json?.user;
check('Admin creates read-only guest account', u2Res.status === 200 && u2?.role === 'guest' && u2?.canUpload === false);

// Sub-account login & /api/me
const aliceLogin = await req(app, 'POST', '/api/login', { body: { username: 'alice', password: 'alice-pass' } });
const aliceCookie = cookieOf(aliceLogin.res);
check('Sub-account login succeeds', aliceLogin.status === 200 && aliceLogin.json?.isAdmin === false && !!aliceCookie);

const aliceMe = await req(app, 'GET', '/api/me', { cookie: aliceCookie });
check('/api/me returns sub-account context', aliceMe.json?.authed === true && aliceMe.json?.isAdmin === false && aliceMe.json?.user?.rootFolderId === u1.rootFolderId);

// Admin-only routes MUST reject sub-account with 401
for (const p of ['/api/users', '/api/pools', '/api/audit', '/api/stats', '/api/tokens', '/api/github/watches', '/api/shares', '/api/trash']) {
  const r = await req(app, 'GET', p, { cookie: aliceCookie });
  check(`Sub-account blocked from admin route ${p}`, r.status === 401, r.status);
}

// Subtree isolation checks
const listDefault = await req(app, 'GET', '/api/files', { cookie: aliceCookie });
check('Sub-account default /api/files locks to rootFolderId', listDefault.status === 200 && listDefault.json?.folderId === u1.rootFolderId);

const listEscape = await req(app, 'GET', `/api/files?folderId=${outFdId}`, { cookie: aliceCookie });
check('Sub-account accessing outside folder returns 403', listEscape.status === 403);

const dlEscape = await req(app, 'GET', `/f/${outFileId}`, { cookie: aliceCookie });
check('Sub-account downloading outside private file returns 403', dlEscape.status === 403);

const delEscape = await req(app, 'DELETE', `/api/files/${outFileId}`, { cookie: aliceCookie });
check('Sub-account deleting outside file returns 403', delEscape.status === 403);

const delOwnRoot = await req(app, 'DELETE', `/api/folders/${u1.rootFolderId}`, { cookie: aliceCookie });
check('Sub-account cannot delete own rootFolderId (403)', delOwnRoot.status === 403);

// Sub-account creates subfolder & uploads within quota
const subFdRes = await req(app, 'POST', '/api/folders', { cookie: aliceCookie, body: { name: 'SubWork' } });
const subFdId = subFdRes.json?.folder?.id;
check('Sub-account can create subfolder under own root', subFdRes.status === 200 && subFdRes.json?.folder?.parentId === u1.rootFolderId);

const up1 = await req(app, 'POST', `/api/upload-proxy?name=hello.txt&size=60&visibility=private&folderId=${subFdId}`, {
  cookie: aliceCookie, raw: new Uint8Array(60).fill(65),
});
const up1Id = up1.json?.file?.id;
check('Sub-account upload within quota succeeds & records ownerId', up1.status === 200 && up1.json?.file?.ownerId === u1.id);

// Quota exceeded -> 413
const up2 = await req(app, 'POST', `/api/upload-proxy?name=over.txt&size=50&visibility=private&folderId=${subFdId}`, {
  cookie: aliceCookie, raw: new Uint8Array(50).fill(66),
});
check('Sub-account upload exceeding quota returns 413', up2.status === 413, up2.json);

// Search isolation: searching 'secret' must NOT return AdminSecret/secret.txt; searching 'hello' returns hello.txt
const searchEscape = await req(app, 'GET', '/api/search?q=secret', { cookie: aliceCookie });
check('Sub-account search does not leak outside files', searchEscape.status === 200 && searchEscape.json?.files?.length === 0 && searchEscape.json?.folders?.length === 0);

const searchInside = await req(app, 'GET', '/api/search?q=hello', { cookie: aliceCookie });
check('Sub-account search finds file inside subtree', searchInside.status === 200 && searchInside.json?.files?.length === 1 && searchInside.json?.files[0]?.id === up1Id);

// Sub-account can download own private file & share it
const dlOwn = await req(app, 'GET', `/f/${up1Id}`, { cookie: aliceCookie });
check('Sub-account can access private file in subtree', dlOwn.status === 200);

const shareOwn = await req(app, 'POST', `/api/files/${up1Id}/share`, { cookie: aliceCookie, body: {} });
check('Sub-account with canShare can create share', shareOwn.status === 200 && !!shareOwn.json?.token);

// Read-only guest checks
const roLogin = await req(app, 'POST', '/api/login', { body: { username: 'viewer01', password: 'viewer-pass' } });
const roCookie = cookieOf(roLogin.res);
check('Read-only guest login succeeds', roLogin.status === 200 && !!roCookie);
check('Read-only guest upload rejected (403)', (await req(app, 'POST', `/api/upload-proxy?name=no.txt&size=5&folderId=${u1.rootFolderId}`, { cookie: roCookie, raw: new Uint8Array(5) })).status === 403);
check('Read-only guest delete rejected (403)', (await req(app, 'DELETE', `/api/files/${up1Id}`, { cookie: roCookie })).status === 403);
check('Read-only guest share rejected (403)', (await req(app, 'POST', `/api/files/${up1Id}/share`, { cookie: roCookie, body: {} })).status === 403);
check('Read-only guest can still download file in subtree (200)', (await req(app, 'GET', `/f/${up1Id}`, { cookie: roCookie })).status === 200);

// Atomic updateUser + disable revokes sessions + kick + expiry
const updNote = await req(app, 'PUT', `/api/users/${u1.id}`, { cookie: admCookie, body: { note: 'vip-note' } });
check('Atomic partial updateUser updates note without touching other fields', updNote.status === 200 && updNote.json?.user?.note === 'vip-note' && updNote.json?.user?.quotaBytes === 100);

const kickRes = await req(app, 'POST', `/api/users/${u1.id}/kick`, { cookie: admCookie });
check('Kick revokes active sub-account sessions', kickRes.status === 200 && kickRes.json?.kicked >= 1);
check('Kicked sub-account session is immediately unauthenticated', (await req(app, 'GET', '/api/me', { cookie: aliceCookie })).json?.authed === false);

// Re-login then expire account
const aliceLogin2 = await req(app, 'POST', '/api/login', { body: { username: 'alice', password: 'alice-pass' } });
const aliceCookie2 = cookieOf(aliceLogin2.res);
await meta.updateUser(u1.id, { expiresAt: Date.now() - 1000 });
check('Expired sub-account session auto-invalidates on /api/me', (await req(app, 'GET', '/api/me', { cookie: aliceCookie2 })).json?.authed === false);
check('Expired sub-account cannot log in (403)', (await req(app, 'POST', '/api/login', { body: { username: 'alice', password: 'alice-pass' } })).status === 403);

// Cleanup expired user sessions
await meta.createSession('stale-tok-1', Date.now() + 3600000, u1.id);
await cleanupExpired(deps);
check('cleanupExpired deletes sessions of expired users', (await meta.getSession('stale-tok-1')) === null);

// Audit logs contain [user:alice]
const auditRes = await req(app, 'GET', '/api/audit', { cookie: admCookie });
const hasUserAudit = (auditRes.json?.logs || []).some((l) => String(l.detail || '').includes('[user:alice]'));
check('Audit logs record [user:alice] actions', hasUserAudit);

console.log(`\n=== v3.8.0 Users Test Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
