// RelayBox v3.9.0 verification: Douyin / Short-video Media Parser + Telegram Bot Auto-Save Webhook.
// Tests: share text URL extraction, platform detection, SSRF guard, built-in Douyin _ROUTER_DATA
// watermark-free parsing, custom parser API fallback, /api/media/parse-save end-to-end save,
// and /api/tg/webhook secret token + chat_id whitelist + auto-parse/save/reply flow.
// Usage: node test-v390-media.mjs

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './src/core/app.js';
import { D1MetaStore } from './src/adapters/cf/d1-meta.js';
import { extractShareUrl, detectPlatform, parseDouyinRouterHtml } from './src/core/lib/media-parser.js';
import { saveTelegramConfig } from './src/core/lib/notify.js';

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
    return o ? new Response(o.bytes, { status: 200, headers: { 'Content-Type': opts.contentType || o.contentType } }) : null;
  }
  async head(key) { const o = this.objs.get(key); return o ? { size: o.bytes.byteLength } : null; }
  async delete(key) { this.objs.delete(key); }
  async copy(a, b) { const o = this.objs.get(a); if (o) this.objs.set(b, { ...o }); }
  async rename(a, b) { const o = this.objs.get(a); if (o) { this.objs.set(b, o); this.objs.delete(a); } }
  async presignedPutUrl(k) { return `https://r2.example.com/put/${k}`; }
  async presignedGetUrl(k) { return `https://r2.example.com/get/${k}`; }
  async createMultipartUpload() { return 'mpu-1'; }
  async presignedPartUrl() { return 'https://r2.example.com/part'; }
  async completeMultipartUpload() {}
  async abortMultipartUpload() {}
  async putFile() {}
  async putThumb(id, buf) { this.thumbs.set(id, new Uint8Array(buf)); }
  async getThumb(id) { return this.thumbs.get(id) || null; }
  async deleteThumb(id) { this.thumbs.delete(id); }
}

// 1. Pure unit tests for share text extraction & Douyin HTML parser
{
  const sample = '7.15 复制打开抖音，看看【颜控kaho的作品】遗失的心跳# 有村架纯 https://v.douyin.com/HS4XVM-JoJQ/ 11/17 c@n.dN';
  const u = extractShareUrl(sample);
  check('extractShareUrl extracts Douyin URL from Chinese share text', u === 'https://v.douyin.com/HS4XVM-JoJQ/', u);
  check('detectPlatform identifies douyin', detectPlatform(u) === 'douyin');
  check('detectPlatform identifies bilibili', detectPlatform('https://b23.tv/abc123') === 'bilibili');

  const fakeHtml = `<html><script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      'video_(id)/page': {
        videoInfoRes: {
          item_list: [{
            desc: '遗失的心跳 #有村架纯',
            author: { nickname: '颜控kaho' },
            video: { play_addr: { url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc123'] } },
          }],
        },
      },
    },
  })};</script></html>`;
  const parsed = parseDouyinRouterHtml(fakeHtml);
  check('parseDouyinRouterHtml extracts watermark-free play URL & metadata', parsed && parsed.mediaUrl.includes('/play/') && !parsed.mediaUrl.includes('playwm') && parsed.author === '颜控kaho', parsed);
}

// 2. Full App Integration Tests with mocked upstream fetch
const schemaSql = fs.readFileSync(new URL('./src/schema.sql', import.meta.url), 'utf8');
const d1 = new MockD1(schemaSql);
const r2 = new MockStorage();
const local = new MockStorage();
const meta = new D1MetaStore(d1, r2);

const tgCalls = [];
const mockFetch = async (url, init = {}) => {
  const s = String(url);
  if (s.includes('api.telegram.org')) {
    const body = init.body ? JSON.parse(init.body) : {};
    tgCalls.push({ url: s, body });
    if (s.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (s.startsWith('https://v.douyin.com/HS4XVM-JoJQ')) {
    return new Response(null, { status: 302, headers: { Location: 'https://www.iesdouyin.com/share/video/7439000111222333444/' } });
  }
  if (s.startsWith('https://www.iesdouyin.com/share/video/7439000111222333444')) {
    const html = `<html><script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: {
        'video_(id)/page': {
          videoInfoRes: {
            item_list: [{
              desc: '测试无水印抖音视频',
              author: { nickname: 'DemoAuthor' },
              video: { play_addr: { url_list: ['https://cdn.douyinvod.example/aweme/v1/playwm/?vid=123'] } },
            }],
          },
        },
      },
    })};</script></html>`;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (s.startsWith('https://cdn.douyinvod.example/aweme/v1/play/')) {
    return new Response(new Uint8Array(2048).fill(0x55), { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '2048' } });
  }
  if (s.startsWith('https://parser.example.com/api')) {
    return new Response(JSON.stringify({ url: 'https://cdn.douyinvod.example/aweme/v1/play/?vid=custom', title: '外部解析视频', author: 'ExtAuth' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('not found', { status: 404 });
};

const deps = {
  meta, r2, local, fetch: mockFetch,
  config: { uploadPassword: PW, maxUploadSize: 100 * 1024 * 1024 },
  getClientIp: () => '127.0.0.1',
  getClientGeo: () => 'CN',
};
const app = createApp(deps);

const cookieOf = (res) => { const m = (res.headers.get('set-cookie') || '').match(/fs_admin=([^;]+)/); return m ? `fs_admin=${m[1]}` : ''; };
const req = async (method, urlPath, { cookie = '', body = null, headers = {} } = {}) => {
  const h = { ...headers };
  if (cookie) h['Cookie'] = cookie;
  if (body !== null) h['Content-Type'] = 'application/json';
  const r = await app.request(`http://localhost${urlPath}`, { method, headers: h, body: body !== null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.clone().json(); } catch {}
  return { status: r.status, res: r, json };
};

// Admin login
const admC = cookieOf((await req('POST', '/api/login', { body: { username: '', password: PW } })).res);
check('Admin logged in', !!admC);

// Web UI parse-save with full Douyin share text (built-in engine)
const ps1 = await req('POST', '/api/media/parse-save', {
  cookie: admC,
  body: { text: '7.15 复制打开抖音，看看 https://v.douyin.com/HS4XVM-JoJQ/ 11/17', visibility: 'private' },
});
check('Built-in Douyin parse-save succeeds & saves to R2', ps1.status === 200 && ps1.json?.file?.size === 2048 && ps1.json?.parsed?.engine === 'builtin-douyin', ps1.json);

// SSRF protection on parse-save
const ssrf = await req('POST', '/api/media/parse-save', {
  cookie: admC,
  body: { text: 'http://127.0.0.1:8080/secret.mp4' },
});
check('SSRF private IP blocked on /api/media/parse-save (400)', ssrf.status === 400);

// Configure custom parser API + Telegram Bot & Webhook
await saveTelegramConfig(deps, { enabled: true, botToken: '123456:ABCDEF_TEST_TOKEN', chatId: '10086' });
const cfgPut = await req('PUT', '/api/media/config', {
  cookie: admC,
  body: { apiUrl: 'https://parser.example.com/api', tgWebhookEnabled: true, tgAllowedChats: '10086' },
});
check('Save media parser & TG webhook config succeeds', cfgPut.status === 200 && cfgPut.json?.config?.tgWebhookEnabled === true);

const ps2 = await req('POST', '/api/media/parse-save', {
  cookie: admC,
  body: { text: 'https://b23.tv/demo123' },
});
check('Custom parser API parses & saves non-Douyin link', ps2.status === 200 && ps2.json?.parsed?.engine === 'custom-api' && ps2.json?.file?.name.includes('外部解析视频'), ps2.json);

// Register TG webhook
const regRes = await req('POST', '/api/media/tg-webhook/register', { cookie: admC, body: {} });
check('One-click Telegram setWebhook succeeds', regRes.status === 200 && tgCalls.some((c) => c.url.endsWith('/setWebhook')));

// Read stored secret from settings for webhook test
const rawCfg = JSON.parse(await meta.getSetting('media_parser'));
const secret = rawCfg.tgWebhookSecret;

// Webhook rejects missing / wrong secret token
const whBad = await req('POST', '/api/tg/webhook', {
  headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
  body: { message: { message_id: 1, chat: { id: 10086 }, text: 'https://v.douyin.com/HS4XVM-JoJQ/' } },
});
check('TG webhook rejects invalid secret token (403)', whBad.status === 403);

// Webhook ignores unauthorized chat_id
const whUnauth = await req('POST', '/api/tg/webhook', {
  headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
  body: { message: { message_id: 2, chat: { id: 999999 }, text: 'https://v.douyin.com/HS4XVM-JoJQ/' } },
});
check('TG webhook ignores non-whitelisted chat_id', whUnauth.status === 200 && whUnauth.json?.ignored === 'chat_not_allowed');

// Webhook accepts whitelisted chat_id, parses, saves & replies with link
const beforeEdits = tgCalls.length;
const whOk = await req('POST', '/api/tg/webhook', {
  headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
  body: { message: { message_id: 3, chat: { id: 10086 }, text: '快看这个 https://v.douyin.com/HS4XVM-JoJQ/' } },
});
const replyCall = tgCalls.slice(beforeEdits).find((c) => c.url.endsWith('/editMessageText'));
check('TG webhook parses Douyin link, saves file & replies with RelayBox link', whOk.status === 200 && replyCall && replyCall.body.text.includes('已转存到 RelayBox') && replyCall.body.text.includes('/f/'), replyCall);


// 3. v3.9.1 tests: nested video_data.nwm_video_url_HQ, TG /id helper, and API token reveal
{
  const idBefore = tgCalls.length;
  const idRes = await req('POST', '/api/tg/webhook', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: { message: { message_id: 10, chat: { id: 888888, type: 'private' }, text: '/id' } },
  });
  const idReply = tgCalls.slice(idBefore).find((c) => c.url.endsWith('/sendMessage'));
  check('TG /id command replies with Chat ID & whitelist hint', idRes.status === 200 && idRes.json?.command === 'id' && idReply && idReply.body.text.includes('888888'));

  // API Token create + reveal + unauth block
  const tkCreate = await req('POST', '/api/tokens', { cookie: admC, body: { name: 'WebDAV Sync', scope: 'all' } });
  const createdTok = tkCreate.json?.token;
  const createdId = tkCreate.json?.id;
  check('API token created with hasReveal=true', tkCreate.status === 200 && !!createdTok && tkCreate.json?.hasReveal === true);

  const tkList = await req('GET', '/api/tokens', { cookie: admC });
  const listed = (tkList.json?.tokens || []).find((x) => x.id === createdId);
  check('API token list exposes hasReveal without plaintext/ciphertext', listed && listed.hasReveal === true && !listed.token && !listed.tokenEnc);

  const tkRevUnauth = await req('GET', `/api/tokens/${createdId}/reveal`);
  check('Unauthenticated token reveal rejected (401)', tkRevUnauth.status === 401);

  const tkRev = await req('GET', `/api/tokens/${createdId}/reveal`, { cookie: admC });
  check('Admin token reveal returns exact original plaintext token', tkRev.status === 200 && tkRev.json?.token === createdTok);
}

console.log(`\n=== v3.9.0 Media & TG Webhook Test Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
