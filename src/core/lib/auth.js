// RelayBox core lib — auth helpers (pure Hono/Web APIs; no Node deps).
// Mirrors v2.8.4's isAuthed / passwordBlocked / recordPasswordResult / chunkAuthed.

import { parseCookies, newSessionToken, SESSION_TTL, FAIL_LIMIT, FAIL_WINDOW_MS } from './util.js';

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

/** Admin session check: fs_admin cookie -> MetaStore session (expiry enforced). */
export async function isAuthed(c, deps) {
  const token = parseCookies(c.req.header('Cookie')).fs_admin;
  if (!token) return false;
  const s = await deps.meta.getSession(token);
  return !!s;
}

/** Create a session and return its token (7-day TTL, same as v2.8.4). */
export async function newSession(deps) {
  const token = newSessionToken();
  await deps.meta.createSession(token, Date.now() + SESSION_TTL);
  return token;
}

/** Is this IP currently rate-limit blocked? */
export async function isBlocked(deps, ip) {
  return deps.meta.isBlocked(ip);
}

export async function recordPasswordResult(deps, ip, ok) {
  if (ok) {
    await deps.meta.clearFailures(ip);
  } else {
    await deps.meta.recordFailure(ip, Date.now());
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
    await recordPasswordResult(deps, ip, false);
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

/** Cookie helpers for login/logout (same attributes as v2.8.4). */
export function setSessionCookie(c, token) {
  c.header('Set-Cookie', `fs_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);
}
export function clearSessionCookie(c) {
  c.header('Set-Cookie', 'fs_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
export function sessionTokenOf(c) {
  return parseCookies(c.req.header('Cookie')).fs_admin || '';
}
