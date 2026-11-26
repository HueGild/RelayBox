// RelayBox core lib — auth helpers (pure Hono/Web APIs; no Node deps).
// v3.8.0: unified getAuthContext(c, deps), subtree sandbox guard, and user quota check.
// Backward compatibility: isAuthed(c, deps) strictly returns true ONLY for main admin.

import { parseCookies, newSessionToken, SESSION_TTL, FAIL_LIMIT, FAIL_WINDOW_MS } from './util.js';
import { notifyAuthBlocked } from './notify.js';

/**
 * Client IP: X-Forwarded-For first entry, else the runtime-provided address
 * (the entry injects deps.getClientIp; @hono/node-server's getConnInfo / CF cf-connecting-ip).
 */
export function clientIp(c, deps) {
  const xff = (c.req.header('x-forwarded-for') || '').split(',')[0].trim();
  if (xff) return xff;
  if (deps && typeof deps.getClientIp === 'function') {
    try {
      const addr = deps.getClientIp(c);
      if (addr) return addr;
    } catch { /* ignore */ }
  }
  return 'unknown';
}

/**
 * Client geo string (v3.1.5): Cloudflare Workers native request.cf
 * (country / region / city) injected via deps.getClientGeo, falling back
 * to CF-IPCountry header when proxied through Cloudflare.
 */
export function clientGeo(c, deps) {
  if (deps && typeof deps.getClientGeo === 'function') {
    try {
      const geo = String(deps.getClientGeo(c) || '').trim();
      if (geo) return geo.slice(0, 120);
    } catch { /* ignore */ }
  }
  const country = (c.req.header('cf-ipcountry') || '').trim();
  if (country && country !== 'XX' && country !== 'T1') return country.slice(0, 32);
  return '';
}

/** Capture uploader IP & geo on file creation (stored on file record; admin-only on read). */
export function clientMeta(c, deps) {
  const rawIp = clientIp(c, deps);
  const uploadIp = (rawIp && rawIp !== 'unknown') ? String(rawIp).slice(0, 64) : null;
  const rawGeo = clientGeo(c, deps);
  const uploadGeo = rawGeo ? rawGeo : null;
  return { uploadIp, uploadGeo };
}

/**
 * Unified auth context (v3.8.0):
 * - No valid session -> { authed: false, isAdmin: false, user: null }
 * - session.userId is null -> { authed: true, isAdmin: true, user: null }
 * - session.userId is set -> loads user and verifies enabled && !expired in real time.
 *   Disabled or expired users have their session revoked and cookie cleared immediately.
 */
export async function getAuthContext(c, deps) {
  try {
    const cached = c.get && c.get('_authCtx');
    if (cached) return cached;
  } catch {}
  const token = parseCookies(c.req.header('Cookie')).fs_admin;
  if (!token) {
    const out = { authed: false, isAdmin: false, user: null };
    try { if (c.set) c.set('_authCtx', out); } catch {}
    return out;
  }
  const s = await deps.meta.getSession(token);
  if (!s) {
    const out = { authed: false, isAdmin: false, user: null };
    try { if (c.set) c.set('_authCtx', out); } catch {}
    return out;
  }
  if (!s.userId) {
    const out = { authed: true, isAdmin: true, user: null };
    try { if (c.set) c.set('_authCtx', out); } catch {}
    return out;
  }
  if (typeof deps.meta.getUser !== 'function') {
    const out = { authed: false, isAdmin: false, user: null };
    try { if (c.set) c.set('_authCtx', out); } catch {}
    return out;
  }
  const user = await deps.meta.getUser(s.userId);
  const now = Date.now();
  if (!user || !user.enabled || (user.expiresAt && user.expiresAt <= now)) {
    try { await deps.meta.deleteSession(token); } catch {}
    try { clearSessionCookie(c); } catch {}
    const out = { authed: false, isAdmin: false, user: null };
    try { if (c.set) c.set('_authCtx', out); } catch {}
    return out;
  }
  const out = { authed: true, isAdmin: false, user };
  try { if (c.set) c.set('_authCtx', out); } catch {}
  return out;
}

/**
 * Main admin session check (strictly main admin only, v3.8.0):
 * Keeps all admin-only routes safe from accidental sub-account exposure.
 */
export async function isAuthed(c, deps) {
  const ctx = await getAuthContext(c, deps);
  return !!(ctx.authed && ctx.isAdmin);
}

/**
 * Verify that `folderId` equals `rootFolderId` or is a descendant of `rootFolderId`.
 * Walks up parent_id up to 16 levels with cycle protection.
 */
export async function assertFolderInSubtree(deps, folderId, rootFolderId, foldersCache = null) {
  if (!folderId || !rootFolderId) return false;
  if (folderId === rootFolderId) return true;
  let folderMap = null;
  if (foldersCache instanceof Map) {
    folderMap = foldersCache;
  } else if (Array.isArray(foldersCache)) {
    folderMap = new Map(foldersCache.map((f) => [f.id, f]));
  }
  let curId = folderId;
  const seen = new Set();
  for (let depth = 0; depth < 16 && curId; depth++) {
    if (curId === rootFolderId) return true;
    if (seen.has(curId)) return false;
    seen.add(curId);
    const fd = folderMap ? folderMap.get(curId) : await deps.meta.getFolder(curId);
    if (!fd) return false;
    curId = fd.parentId || null;
  }
  return curId === rootFolderId;
}

/** Check whether a sub-account has enough remaining quota for `incomingSize` bytes. */
export async function checkUserQuota(deps, user, incomingSize = 0) {
  if (!user) return { ok: true, usedBytes: 0, quotaBytes: 0 };
  const quotaBytes = Number(user.quotaBytes) > 0 ? Number(user.quotaBytes) : 0;
  const usedBytes = (typeof deps.meta.getUserUsedBytes === 'function')
    ? await deps.meta.getUserUsedBytes(user.id)
    : 0;
  if (quotaBytes > 0 && usedBytes + Math.max(0, Number(incomingSize) || 0) > quotaBytes) {
    return { ok: false, usedBytes, quotaBytes };
  }
  return { ok: true, usedBytes, quotaBytes };
}

/** Prefix helper for audit_logs detail so main admin can trace sub-account actions. */
export function auditUserPrefix(authCtx) {
  return (authCtx && authCtx.user && authCtx.user.username)
    ? `[user:${authCtx.user.username}] `
    : '';
}

/** Create a session and return its token (7-day TTL, capped by user.expiresAt if earlier). */
export async function newSession(deps, userId = null, maxExpiresAt = null) {
  const token = newSessionToken();
  let exp = Date.now() + SESSION_TTL;
  if (typeof maxExpiresAt === 'number' && Number.isFinite(maxExpiresAt) && maxExpiresAt > 0 && maxExpiresAt < exp) {
    exp = maxExpiresAt;
  }
  await deps.meta.createSession(token, exp, userId || null);
  return token;
}

/** Is this IP currently rate-limit blocked? */
export async function isBlocked(deps, ip) {
  return deps.meta.isBlocked(ip);
}

/** Record an auth failure and fire a Telegram alert right when IP crosses FAIL_LIMIT. */
export async function recordFailureWithAlert(deps, ip, c, source) {
  const now = Date.now();
  await deps.meta.recordFailure(ip, now);
  try {
    const count = await deps.meta.countFailuresSince(ip, now - FAIL_WINDOW_MS);
    if (count === FAIL_LIMIT) {
      notifyAuthBlocked(deps, c, {
        ip,
        geo: c ? clientGeo(c, deps) : '',
        source: source || '密码校验',
      });
    }
  } catch { /* never break auth flow */ }
}

export async function recordPasswordResult(deps, ip, ok, c, source) {
  if (ok) {
    await deps.meta.clearFailures(ip);
  } else {
    await recordFailureWithAlert(deps, ip, c, source);
  }
}

/**
 * Endpoints that accept "logged-in admin OR password":
 * returns 'ok' | 'blocked' | 'wrong'.
 * `password` is the caller-supplied password (JSON body field or X-Upload-Password).
 * Mirrors v2.8.4: success clears the failure record, failure counts toward the limit.
 */
export async function authOrPassword(c, deps, password) {
  if (await isAuthed(c, deps)) return 'ok';
  const ip = clientIp(c, deps);
  if (await isBlocked(deps, ip)) return 'blocked';
  if ((password || '') !== deps.config.uploadPassword) {
    await recordPasswordResult(deps, ip, false, c, '上传密码验证');
    return 'wrong';
  }
  await recordPasswordResult(deps, ip, true);
  return 'ok';
}

/** The three standard auth-failure responses (same messages as v2.8.4). */
export function authFail(c, status) {
  if (status === 'blocked') return c.json({ ok: false, error: '尝试太频繁，10 分钟后再试' }, 429);
  return c.json({ ok: false, error: '密码不对' }, 401);
}

function isSecureRequest(c) {
  try {
    const xfProto = (c && c.req && c.req.header('x-forwarded-proto')) || '';
    if (xfProto.toLowerCase().startsWith('https')) return true;
    if (c && c.req && c.req.url && new URL(c.req.url).protocol === 'https:') return true;
  } catch {}
  return false;
}
/** Cookie helpers for login/logout (auto-adds Secure on HTTPS). */
export function setSessionCookie(c, token) {
  const sec = isSecureRequest(c) ? '; Secure' : '';
  c.header('Set-Cookie', `fs_admin=${token}; Path=/; HttpOnly; SameSite=Lax${sec}; Max-Age=${7 * 24 * 60 * 60}`);
}
export function clearSessionCookie(c) {
  const sec = isSecureRequest(c) ? '; Secure' : '';
  c.header('Set-Cookie', `fs_admin=; Path=/; HttpOnly; SameSite=Lax${sec}; Max-Age=0`);
}
export function sessionTokenOf(c) {
  return parseCookies(c.req.header('Cookie')).fs_admin || '';
}
