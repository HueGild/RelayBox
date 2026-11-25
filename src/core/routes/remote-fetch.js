// RelayBox core routes — Remote URL Fetch / Offline Save to Storage Pool (v3.3.4).
// Pure Web APIs (fetch + AbortController + ReadableStream). Zero Node built-in deps.
// Admin-only endpoint with strict SSRF protection, manual redirect validation,
// streaming byte-cap enforcement, and multi-storage pool routing.

import {
  readJsonBody, newId, safeName, extOf, kindOf, keyOf,
  parseExpiresHours, expiresAtOf, MIN_FREE_BYTES, MIME, log,
} from '../lib/util.js';
import { isAuthed, clientMeta } from '../lib/auth.js';
import { resolveUploadTarget } from './pools.js';

const DEFAULT_MAX_REMOTE_BYTES = 50 * 1024 * 1024; // 50MB (safe for CF Workers 128MB memory)
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-7z-compressed': '.7z',
  'application/vnd.rar': '.rar',
  'application/json': '.json',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
  'text/css': '.css',
  'text/csv': '.csv',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/vnd.android.package-archive': '.apk',
};

function isPrivateIpv4Parts(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true;            // Link-local / Cloud Metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
  if (a >= 224) return true;                          // Multicast & reserved
  return false;
}

function isBlockedHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    host === 'instance-data'
  ) {
    return true;
  }

  // Standard dotted decimal IPv4
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((n) => n < 0 || n > 255)) return true;
    return isPrivateIpv4Parts(parts[0], parts[1]);
  }

  // Obfuscated integer / hex / octal IPv4 hostnames (e.g. 2130706433, 0x7f000001, 0177.0.0.1)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^[0-9a-fx.]+$/i.test(host) && host.includes('.') && host.split('.').every((seg) => /^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(seg))) {
    return true;
  }

  // IPv6 checks
  if (host.includes(':')) {
    const h = host.split('%')[0];
    if (h === '::' || h === '::1' || /^0(:0)*:0?1$/.test(h) || /^0(:0)*$/.test(h)) return true;
    // Unique local fc00::/7 (fc.. / fd..), link-local fe80::/10 (fe80..febf), multicast ff..
    if (/^(fc|fd|fe[89ab]|ff)/i.test(h)) return true;
    // IPv4-mapped IPv6 ::ffff:a.b.c.d or ::ffff:xxxx:xxxx
    const v4MappedDec = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(h);
    if (v4MappedDec) {
      return isPrivateIpv4Parts(Number(v4MappedDec[1]), Number(v4MappedDec[2]));
    }
    const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1], 16);
      return isPrivateIpv4Parts((hi >> 8) & 0xff, hi & 0xff);
    }
  }
  return false;
}

/** Validate a remote URL against scheme, credentials, and SSRF blocklists. */
export function validateRemoteUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return { ok: false, error: '请输入要拉取的文件链接' };
  if (s.length > 2048) return { ok: false, error: '链接过长' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: '链接格式不对，请输入完整的 http:// 或 https:// 地址' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http:// 或 https:// 协议的链接' };
  }
  if (u.username || u.password) {
    return { ok: false, error: '不支持包含账号密码凭据的链接' };
  }
  if (isBlockedHost(u.hostname)) {
    return { ok: false, error: '出于安全限制，不允许拉取内网或本机地址' };
  }
  return { ok: true, url: u.toString() };
}

function parseContentDispositionName(header) {
  const s = String(header || '');
  if (!s) return '';
  // RFC 5987 filename*=UTF-8''...
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i.exec(s);
  if (star && star[1]) {
    try { return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, '')); } catch { return star[1].trim(); }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(s);
  if (quoted && quoted[1]) return quoted[1].trim();
  const bare = /filename\s*=\s*([^;\r\n]+)/i.exec(s);
  if (bare && bare[1]) return bare[1].trim().replace(/^["']|["']$/g, '');
  return '';
}

function extFromContentType(ct) {
  const base = String(ct || '').split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] || '';
}

export function resolveRemoteFilename(customName, contentDisposition, finalUrl, contentType) {
  const custom = String(customName || '').trim();
  if (custom) return safeName(custom);

  let raw = parseContentDispositionName(contentDisposition);
  if (!raw) {
    try {
      const u = new URL(finalUrl);
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length) {
        try { raw = decodeURIComponent(segs[segs.length - 1]); } catch { raw = segs[segs.length - 1]; }
      }
    } catch {}
  }

  let name = raw ? safeName(raw) : '';
  if (!name || name === 'file') {
    const ext = extFromContentType(contentType);
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    return safeName(`remote_${stamp}${ext || '.bin'}`);
  }
  if (!extOf(name)) {
    const ext = extFromContentType(contentType);
    if (ext) name = safeName(name + ext);
  }
  return name;
}

async function fetchWithValidatedRedirects(fetchFn, startUrl, signal) {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'RelayBox-RemoteFetch/3.3.4' },
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || res.headers.get('Location');
      if (!loc) return { ok: false, status: 502, error: '远程服务器返回了无效重定向' };
      if (hop === MAX_REDIRECTS) return { ok: false, status: 502, error: '远程链接重定向次数过多' };
      let nextUrl;
      try { nextUrl = new URL(loc, currentUrl).toString(); }
      catch { return { ok: false, status: 502, error: '远程重定向地址无效' }; }
      const check = validateRemoteUrl(nextUrl);
      if (!check.ok) return { ok: false, status: 400, error: check.error };
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
      currentUrl = check.url;
      continue;
    }
    return { ok: true, res, finalUrl: currentUrl };
  }
  return { ok: false, status: 502, error: '远程链接重定向次数过多' };
}

async function readStreamWithLimit(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, bytes: new Uint8Array(ab) };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch (e) {
    try { await reader.cancel(); } catch {}
    throw e;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return { ok: true, bytes: out };
}

export function registerRemoteFetch(app) {
  app.post('/api/remote-fetch', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);

    const body = await readJsonBody(c);
    const urlCheck = validateRemoteUrl(body.url);
    if (!urlCheck.ok) return c.json({ ok: false, error: urlCheck.error }, 400);

    let folderId = (typeof body.folderId === 'string' && body.folderId.trim()) ? body.folderId.trim() : null;
    if (folderId) {
      const fd = await deps.meta.getFolder(folderId);
      if (!fd) return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
    }

    const target = await resolveUploadTarget(deps, body.poolId, body.storage);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 400);
    if (target.storage === 'local' && deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }

    const configLimit = Number(deps.config.remoteFetchMaxBytes) > 0
      ? Number(deps.config.remoteFetchMaxBytes)
      : DEFAULT_MAX_REMOTE_BYTES;
    const siteMax = Number(deps.config.maxUploadSize) > 0 ? Number(deps.config.maxUploadSize) : configLimit;
    const maxBytes = Math.min(configLimit, siteMax);
    const timeoutMs = Number(deps.config.remoteFetchTimeoutMs) > 0
      ? Number(deps.config.remoteFetchTimeoutMs)
      : DEFAULT_TIMEOUT_MS;

    const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let remoteRes;
    let finalUrl = urlCheck.url;
    let bytes;
    try {
      const fetched = await fetchWithValidatedRedirects(fetchFn, urlCheck.url, controller.signal);
      if (!fetched.ok) return c.json({ ok: false, error: fetched.error }, fetched.status || 400);
      remoteRes = fetched.res;
      finalUrl = fetched.finalUrl;

      if (!remoteRes.ok) {
        try { if (remoteRes.body && typeof remoteRes.body.cancel === 'function') await remoteRes.body.cancel(); } catch {}
        return c.json({ ok: false, error: `远程服务器返回 HTTP ${remoteRes.status}` }, 502);
      }

      const contentLen = Number(remoteRes.headers.get('content-length') || 0);
      if (Number.isFinite(contentLen) && contentLen > maxBytes) {
        try { if (remoteRes.body && typeof remoteRes.body.cancel === 'function') await remoteRes.body.cancel(); } catch {}
        return c.json({ ok: false, error: `远程文件超过大小上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）` }, 413);
      }

      const read = await readStreamWithLimit(remoteRes, maxBytes);
      if (!read.ok && read.tooLarge) {
        return c.json({ ok: false, error: `远程文件超过大小上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）` }, 413);
      }
      bytes = read.bytes;
    } catch (e) {
      const isTimeout = e && e.name === 'AbortError';
      return c.json({ ok: false, error: isTimeout ? '拉取远程文件超时' : ('拉取失败：' + ((e && e.message) || '网络错误')) }, isTimeout ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }

    if (!bytes || bytes.byteLength <= 0) {
      return c.json({ ok: false, error: '远程文件为空（0 字节）' }, 400);
    }

    const contentType = remoteRes.headers.get('content-type') || '';
    const contentDisp = remoteRes.headers.get('content-disposition') || '';
    const filename = resolveRemoteFilename(body.name, contentDisp, finalUrl, contentType);
    const ext = extOf(filename);
    const mime = MIME[ext] || contentType.split(';')[0].trim() || 'application/octet-stream';
    const id = newId();
    const key = keyOf(id, filename);

    try {
      if (target.storage === 'r2' && target.driver.proxySupported === false && target.driver.presignEnabled) {
        const putUrl = await target.driver.presignedPutUrl(key, { contentLength: bytes.byteLength, expiresIn: 300 });
        const putRes = await fetchFn(putUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
        if (!putRes.ok) throw new Error(`presign PUT HTTP ${putRes.status}`);
      } else {
        await target.driver.put(key, bytes, mime);
      }
    } catch (e) {
      log('remote-fetch save failed:', e && e.message);
      return c.json({ ok: false, error: '写入存储池失败：' + ((e && e.message) || '未知错误') }, 500);
    }

    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id,
      name: filename,
      size: bytes.byteLength,
      ext,
      kind: kindOf(ext),
      visibility: body.visibility === 'public' ? 'public' : 'private',
      storage: target.storage,
      storageKey: key,
      folderId,
      expiresAt: expiresAtOf(parseExpiresHours(body.expires || 0)),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp,
      uploadGeo,
      width: null,
      height: null,
      poolId: target.poolId || null,
    };

    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('remote-fetch meta save failed:', e && e.message);
      try { await target.driver.delete(key); } catch {}
      return c.json({ ok: false, error: '保存文件记录失败' }, 500);
    }

    const poolName = target.pool ? target.pool.name : (target.storage === 'local' ? '本地磁盘' : '内置 R2');
    log('remote-fetched:', filename, (bytes.byteLength / 1024 / 1024).toFixed(2) + 'MB ->', poolName);
    return c.json({ ok: true, file: { ...item, poolName }, sourceUrl: finalUrl });
  });
}
