// RelayBox core lib — Douyin / Short-video Media Link Parser & Saver (v3.9.0).
// Pure Web APIs (fetch + AbortController + Web Crypto). Zero Node built-in deps.
// Dual-engine architecture:
//   1. Custom external parser API (Cobalt / generic JSON API, optional AES-GCM API key)
//   2. Built-in zero-config Douyin mobile share page parser (playwm -> play)

import { encryptSecret, decryptSecret, maskAccessKey } from './crypto.js';
import {
  newId, safeName, extOf, kindOf, keyOf,
  parseExpiresHours, expiresAtOf, MIME, log,
} from './util.js';
import { validateRemoteUrl, resolveRemoteFilename } from '../routes/remote-fetch.js';
import { resolveUploadTarget } from '../routes/pools.js';

export const SETTING_MEDIA_PARSER = 'media_parser';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DEFAULT_MAX_MEDIA_BYTES = 80 * 1024 * 1024; // 80 MB
const MAX_REDIRECTS = 6;
const PARSE_TIMEOUT_MS = 18_000;
const DOWNLOAD_TIMEOUT_MS = 45_000;

function randomSecret(len = 28) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

/** Extract the first http(s) URL from a share text block (e.g. Douyin copy-paste). */
export function extractShareUrl(rawText) {
  const s = String(rawText || '').trim();
  if (!s) return '';
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return '';
  return m[0].replace(/[)\]}】」』》〉，。！？；、]+$/g, '');
}

/** Detect known short-video platform by hostname. */
export function detectPlatform(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    if (h === 'v.douyin.com' || h.endsWith('.douyin.com') || h.endsWith('.iesdouyin.com')) return 'douyin';
    if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return 'tiktok';
    if (h === 'b23.tv' || h.endsWith('.bilibili.com')) return 'bilibili';
    if (h === 'xhslink.com' || h.endsWith('.xiaohongshu.com')) return 'xiaohongshu';
    return 'generic';
  } catch {
    return 'generic';
  }
}

export async function getMediaParserConfig(deps) {
  const fallback = {
    apiUrl: '',
    apiKeyEnc: '',
    apiKeyPreview: '',
    tgWebhookEnabled: false,
    tgWebhookSecret: '',
    tgAllowedChats: '',
    tgFolderId: '',
    tgPoolId: '',
    tgVisibility: 'private',
    maxBytes: DEFAULT_MAX_MEDIA_BYTES,
  };
  try {
    const raw = await deps.meta.getSetting(SETTING_MEDIA_PARSER);
    if (!raw) return fallback;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return fallback;
    return {
      apiUrl: typeof o.apiUrl === 'string' ? o.apiUrl.trim() : '',
      apiKeyEnc: typeof o.apiKeyEnc === 'string' ? o.apiKeyEnc : '',
      apiKeyPreview: typeof o.apiKeyPreview === 'string' ? o.apiKeyPreview : '',
      tgWebhookEnabled: o.tgWebhookEnabled === true,
      tgWebhookSecret: typeof o.tgWebhookSecret === 'string' ? o.tgWebhookSecret : '',
      tgAllowedChats: typeof o.tgAllowedChats === 'string' ? o.tgAllowedChats.trim() : '',
      tgFolderId: typeof o.tgFolderId === 'string' ? o.tgFolderId.trim() : '',
      tgPoolId: typeof o.tgPoolId === 'string' ? o.tgPoolId.trim() : '',
      tgVisibility: o.tgVisibility === 'public' ? 'public' : 'private',
      maxBytes: Number(o.maxBytes) >= 10 * 1024 * 1024 && Number(o.maxBytes) <= 100 * 1024 * 1024
        ? Math.floor(Number(o.maxBytes))
        : DEFAULT_MAX_MEDIA_BYTES,
    };
  } catch {
    return fallback;
  }
}

export async function getMediaParserPublicConfig(deps, origin = '') {
  const cfg = await getMediaParserConfig(deps);
  return {
    apiUrl: cfg.apiUrl,
    hasApiKey: !!cfg.apiKeyEnc,
    apiKeyPreview: cfg.apiKeyPreview,
    tgWebhookEnabled: cfg.tgWebhookEnabled,
    hasWebhookSecret: !!cfg.tgWebhookSecret,
    tgAllowedChats: cfg.tgAllowedChats,
    tgFolderId: cfg.tgFolderId,
    tgPoolId: cfg.tgPoolId,
    tgVisibility: cfg.tgVisibility,
    maxBytes: cfg.maxBytes,
    webhookUrl: origin ? `${origin}/api/tg/webhook` : '/api/tg/webhook',
  };
}

export async function saveMediaParserConfig(deps, body) {
  const cur = await getMediaParserConfig(deps);
  const next = { ...cur };

  if (body.apiUrl !== undefined) {
    const u = String(body.apiUrl || '').trim();
    if (u) {
      const check = validateRemoteUrl(u.replace(/\{url\}/gi, 'https://v.douyin.com/test/'));
      if (!check.ok) return { ok: false, error: '解析 API 地址无效：' + check.error };
    }
    next.apiUrl = u;
  }
  if (body.clearApiKey === true) {
    next.apiKeyEnc = '';
    next.apiKeyPreview = '';
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const plain = body.apiKey.trim();
    next.apiKeyEnc = await encryptSecret(plain, deps.config.uploadPassword);
    next.apiKeyPreview = maskAccessKey(plain);
  }
  if (typeof body.tgWebhookEnabled === 'boolean') next.tgWebhookEnabled = body.tgWebhookEnabled;
  if (body.tgAllowedChats !== undefined) {
    next.tgAllowedChats = String(body.tgAllowedChats || '')
      .split(/[\s,，]+/)
      .map((x) => x.trim())
      .filter((x) => /^-?\d+$/.test(x))
      .join(',');
  }
  if (body.tgFolderId !== undefined) next.tgFolderId = String(body.tgFolderId || '').trim();
  if (body.tgPoolId !== undefined) next.tgPoolId = String(body.tgPoolId || '').trim();
  if (body.tgVisibility === 'public' || body.tgVisibility === 'private') next.tgVisibility = body.tgVisibility;
  if (body.maxBytes !== undefined) {
    const mb = Number(body.maxBytes);
    if (Number.isFinite(mb) && mb >= 10 * 1024 * 1024 && mb <= 100 * 1024 * 1024) {
      next.maxBytes = Math.floor(mb);
    }
  }
  if (!next.tgWebhookSecret || body.rotateSecret === true) {
    next.tgWebhookSecret = randomSecret(28);
  }

  await deps.meta.setSetting(SETTING_MEDIA_PARSER, JSON.stringify(next));
  return { ok: true, config: next };
}

async function fetchValidatedRedirects(fetchFn, startUrl, headers, signal) {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || res.headers.get('Location');
      if (!loc) return { ok: false, status: 502, error: '无效重定向响应' };
      if (hop === MAX_REDIRECTS) return { ok: false, status: 502, error: '重定向次数过多' };
      let nextUrl;
      try { nextUrl = new URL(loc, currentUrl).toString(); }
      catch { return { ok: false, status: 502, error: '重定向地址无效' }; }
      const check = validateRemoteUrl(nextUrl);
      if (!check.ok) return { ok: false, status: 400, error: check.error };
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
      currentUrl = check.url;
      continue;
    }
    return { ok: true, res, finalUrl: currentUrl };
  }
  return { ok: false, status: 502, error: '重定向次数过多' };
}

/** Extract Douyin aweme video ID from a redirected URL. */
function extractDouyinVideoId(urlStr) {
  const m = String(urlStr || '').match(/\/(?:video|note|slides)\/(\d{10,25})/)
    || String(urlStr || '').match(/[?&](?:modal_id|aweme_id|vid)=(\d{10,25})/);
  return m ? m[1] : '';
}

/** Parse window._ROUTER_DATA JSON from iesdouyin mobile share HTML. */
export function parseDouyinRouterHtml(html) {
  const s = String(html || '');
  const marker = 'window._ROUTER_DATA';
  const idx = s.indexOf(marker);
  if (idx < 0) return null;
  const eq = s.indexOf('=', idx + marker.length);
  if (eq < 0) return null;
  const scriptEnd = s.indexOf('</script>', eq);
  let rawJson = (scriptEnd > eq ? s.slice(eq + 1, scriptEnd) : s.slice(eq + 1)).trim();
  rawJson = rawJson.replace(/;\s*$/, '');
  let data;
  try { data = JSON.parse(rawJson); } catch { return null; }

  const loader = data && data.loaderData;
  if (!loader || typeof loader !== 'object') return null;
  let item = null;
  for (const key of Object.keys(loader)) {
    const entry = loader[key];
    const info = entry && (entry.videoInfoRes || entry.aweme_detail || entry);
    if (info && Array.isArray(info.item_list) && info.item_list[0]) {
      item = info.item_list[0];
      break;
    }
  }
  if (!item) return null;

  const urlList = item.video && item.video.play_addr && Array.isArray(item.video.play_addr.url_list)
    ? item.video.play_addr.url_list
    : [];
  const rawPlay = urlList.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || '';
  if (!rawPlay) return null;

  // Watermark-free URL rewrite (standard iesdouyin playwm -> play)
  const cleanUrl = rawPlay.replace('/playwm/', '/play/').replace('playwm', 'play');
  const title = String(item.desc || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const author = String((item.author && item.author.nickname) || '').trim().slice(0, 40);
  return { mediaUrl: cleanUrl, title, author };
}

/** Pick video URL and metadata from flexible third-party / Cobalt JSON parser responses. */
function pickFromCustomParserJson(json) {
  if (!json || typeof json !== 'object') return null;
  const d = (json.data && typeof json.data === 'object') ? json.data : json;
  const vd = (d.video_data && typeof d.video_data === 'object') ? d.video_data : null;
  const candidates = [
    json.url,
    json.video_url,
    json.videoUrl,
    json.play,
    vd && vd.nwm_video_url_HQ,
    vd && vd.nwm_video_url,
    vd && vd.play,
    d.nwm_video_url_HQ,
    d.nwm_video_url,
    d.hdplay,
    d.play,
    d.video_url,
    d.videoUrl,
    d.url,
    d.video && d.video.play_addr && d.video.play_addr.url_list && d.video.play_addr.url_list[0],
    d.aweme_detail && d.aweme_detail.video && d.aweme_detail.video.play_addr && d.aweme_detail.video.play_addr.url_list && d.aweme_detail.video.play_addr.url_list[0],
    vd && vd.wm_video_url,
  ];
  const mediaUrl = candidates.find((x) => typeof x === 'string' && /^https?:\/\//i.test(x.trim()));
  if (!mediaUrl) return null;
  const title = String(json.filename || json.title || d.title || d.desc || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const author = String(json.author || d.author?.nickname || (typeof d.author === 'string' ? d.author : '') || '').trim().slice(0, 40);
  return { mediaUrl: mediaUrl.trim(), title, author };
}

function buildMediaFilename(customName, title, author, platform, fallbackUrl) {
  const custom = String(customName || '').trim();
  if (custom) {
    const clean = safeName(custom);
    return extOf(clean) ? clean : safeName(clean + '.mp4');
  }
  const baseParts = [];
  if (title) baseParts.push(title.replace(/[#@]+/g, '').trim().slice(0, 50));
  else if (author) baseParts.push(author);
  else baseParts.push(`${platform || 'video'}_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`);
  let base = baseParts.join('_').trim();
  if (!base) base = `video_${Date.now()}`;
  const clean = safeName(base);
  if (!clean || clean === 'file') {
    return resolveRemoteFilename('', '', fallbackUrl, 'video/mp4');
  }
  return extOf(clean) ? clean : safeName(clean + '.mp4');
}

/** Parse a Douyin or short-video share text/URL via configured API or built-in Douyin engine. */
export async function parseMediaLink(deps, rawInput, fetchFn = fetch) {
  const shareUrl = extractShareUrl(rawInput);
  if (!shareUrl) return { ok: false, status: 400, error: '未在文本中识别到有效链接' };
  const valid = validateRemoteUrl(shareUrl);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const platform = detectPlatform(valid.url);
  const cfg = await getMediaParserConfig(deps);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PARSE_TIMEOUT_MS);

  try {
    // 1. Custom external parser API (if configured)
    if (cfg.apiUrl) {
      let apiKey = '';
      if (cfg.apiKeyEnc) {
        try { apiKey = await decryptSecret(cfg.apiKeyEnc, deps.config.uploadPassword); } catch {}
      }
      const headers = { 'Accept': 'application/json', 'User-Agent': 'RelayBox-MediaParser/3.9.0' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      let res;
      if (/\{url\}/i.test(cfg.apiUrl)) {
        const targetApi = cfg.apiUrl.replace(/\{url\}/gi, encodeURIComponent(valid.url));
        const apiCheck = validateRemoteUrl(targetApi);
        if (!apiCheck.ok) return { ok: false, status: 400, error: apiCheck.error };
        res = await fetchFn(apiCheck.url, { method: 'GET', headers, signal: ac.signal });
      } else {
        const apiCheck = validateRemoteUrl(cfg.apiUrl);
        if (!apiCheck.ok) return { ok: false, status: 400, error: apiCheck.error };
        headers['Content-Type'] = 'application/json';
        res = await fetchFn(apiCheck.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ url: valid.url }),
          signal: ac.signal,
        });
      }
      if (res && res.ok) {
        const json = await res.json().catch(() => null);
        const picked = pickFromCustomParserJson(json);
        if (picked && picked.mediaUrl) {
          const mc = validateRemoteUrl(picked.mediaUrl);
          if (mc.ok) {
            return {
              ok: true,
              platform,
              shareUrl: valid.url,
              mediaUrl: mc.url,
              title: picked.title,
              author: picked.author,
              headers: { 'User-Agent': MOBILE_UA },
              engine: 'custom-api',
            };
          }
        }
      }
      // If custom API fails on Douyin, fall through to built-in engine; otherwise return error
      if (platform !== 'douyin') {
        return { ok: false, status: 502, error: '外部解析接口未返回有效视频直链' };
      }
    }

    // 2. Built-in zero-config Douyin parser
    if (platform === 'douyin') {
      let videoId = extractDouyinVideoId(valid.url);
      let pageHtml = '';
      if (!videoId) {
        const hopRes = await fetchValidatedRedirects(
          fetchFn,
          valid.url,
          { 'User-Agent': MOBILE_UA, 'Accept': 'text/html,application/xhtml+xml' },
          ac.signal,
        );
        if (!hopRes.ok) return hopRes;
        videoId = extractDouyinVideoId(hopRes.finalUrl);
        if (hopRes.res.ok) {
          pageHtml = await hopRes.res.text().catch(() => '');
        }
      }

      let parsed = pageHtml ? parseDouyinRouterHtml(pageHtml) : null;
      if (!parsed && videoId) {
        const sharePageUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
        const pRes = await fetchValidatedRedirects(
          fetchFn,
          sharePageUrl,
          { 'User-Agent': MOBILE_UA, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://www.douyin.com/' },
          ac.signal,
        );
        if (pRes.ok && pRes.res.ok) {
          const html = await pRes.res.text().catch(() => '');
          parsed = parseDouyinRouterHtml(html);
        }
      }

      if (parsed && parsed.mediaUrl) {
        const mc = validateRemoteUrl(parsed.mediaUrl);
        if (mc.ok) {
          return {
            ok: true,
            platform: 'douyin',
            shareUrl: valid.url,
            mediaUrl: mc.url,
            title: parsed.title,
            author: parsed.author,
            headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.douyin.com/' },
            engine: 'builtin-douyin',
          };
        }
      }
      return {
        ok: false,
        status: 502,
        error: '抖音内置解析被风控拦截或页面结构已变更，请在设置中配置自定义解析 API',
      };
    }

    // 3. Generic direct media URL fallback
    return {
      ok: true,
      platform: 'generic',
      shareUrl: valid.url,
      mediaUrl: valid.url,
      title: '',
      author: '',
      headers: { 'User-Agent': MOBILE_UA },
      engine: 'direct',
    };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, status: 504, error: '解析链接超时' };
    log('parseMediaLink error:', e && e.message);
    return { ok: false, status: 502, error: '解析失败：' + ((e && e.message) || '网络异常') };
  } finally {
    clearTimeout(timer);
  }
}

/** Download a parsed media URL with SSRF & byte-cap guards and persist to R2/S3 pool + D1. */
export async function downloadAndSaveMedia(deps, opts) {
  const {
    mediaUrl,
    customName = '',
    title = '',
    author = '',
    platform = 'generic',
    shareUrl = '',
    headers = { 'User-Agent': MOBILE_UA },
    folderId: rawFolderId = null,
    poolId = '',
    visibility = 'private',
    expires = '0',
    maxBytes = DEFAULT_MAX_MEDIA_BYTES,
    uploadIp = null,
    uploadGeo = null,
    fetchFn = fetch,
  } = opts || {};

  const mc = validateRemoteUrl(mediaUrl);
  if (!mc.ok) return { ok: false, status: 400, error: mc.error };

  const target = await resolveUploadTarget(deps, poolId, 'r2');
  if (!target.ok) return { ok: false, status: target.status || 501, error: target.error };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const hopRes = await fetchValidatedRedirects(fetchFn, mc.url, headers, ac.signal);
    if (!hopRes.ok) return hopRes;
    const res = hopRes.res;
    if (!res.ok) return { ok: false, status: 502, error: `视频源返回 HTTP ${res.status}` };

    const declaredLen = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
      return { ok: false, status: 413, error: `视频超过单次转存上限（${Math.round(maxBytes / 1048576)} MB）` };
    }

    const chunks = [];
    let total = 0;
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          return { ok: false, status: 413, error: `视频超过单次转存上限（${Math.round(maxBytes / 1048576)} MB）` };
        }
        chunks.push(value);
      }
    } else {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) {
        return { ok: false, status: 413, error: `视频超过单次转存上限（${Math.round(maxBytes / 1048576)} MB）` };
      }
      chunks.push(new Uint8Array(ab));
      total = ab.byteLength;
    }

    if (total <= 0) return { ok: false, status: 502, error: '下载到的视频内容为空' };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }

    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct.startsWith('text/html') && platform !== 'generic') {
      return { ok: false, status: 502, error: '视频源返回了网页而非视频流，可能已被防盗链拦截' };
    }

    let folderId = (typeof rawFolderId === 'string' && rawFolderId.trim()) ? rawFolderId.trim() : null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;

    const filename = buildMediaFilename(customName, title, author, platform, hopRes.finalUrl);
    const ext = extOf(filename) || '.mp4';
    const mime = MIME[ext] || (ct && ct.startsWith('video/') ? ct : 'video/mp4');
    const id = newId();
    const storageKey = keyOf(id, filename);

    await target.driver.put(storageKey, bytes, mime);
    const noteText = [
      author ? `@${author}` : '',
      shareUrl ? `来源: ${shareUrl}` : '',
    ].filter(Boolean).join(' · ').slice(0, 200);

    const item = {
      id,
      name: filename,
      size: bytes.byteLength,
      ext,
      kind: kindOf(ext),
      visibility: visibility === 'public' ? 'public' : 'private',
      storage: target.storage || 'r2',
      storageKey,
      folderId,
      expiresAt: expiresAtOf(parseExpiresHours(expires)),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp,
      uploadGeo,
      width: null,
      height: null,
      poolId: target.poolId || null,
      note: noteText,
      ownerId: null,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      try { await target.driver.delete(storageKey); } catch {}
      throw e;
    }
    return { ok: true, file: item };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, status: 504, error: '下载视频超时' };
    log('downloadAndSaveMedia error:', e && e.message);
    return { ok: false, status: 502, error: '转存失败：' + ((e && e.message) || '网络异常') };
  } finally {
    clearTimeout(timer);
  }
}
