// RelayBox core lib — Cloudflare Workers native edge cache (caches.default).
// Pure Web Standard APIs, zero Node dependencies. Safely no-ops when running
// outside Cloudflare Workers unless a mock cache is injected via deps.cache.

function getCache(deps) {
  if (deps && deps.cache) return deps.cache;
  if (typeof caches !== 'undefined' && caches && caches.default) return caches.default;
  return null;
}

export function originOf(c, deps) {
  try {
    if (c && c.req && c.req.url) return new URL(c.req.url).origin;
  } catch {}
  if (deps && deps.config && typeof deps.config.publicOrigin === 'string' && deps.config.publicOrigin) {
    return deps.config.publicOrigin.replace(/\/+$/, '');
  }
  return '';
}

export function thumbCacheKey(origin, id) {
  return new Request(`${origin}/thumb/${encodeURIComponent(id)}`, { method: 'GET' });
}

export function mediaCacheKey(origin, id) {
  return new Request(`${origin}/f/${encodeURIComponent(id)}`, { method: 'GET' });
}

export function runBackground(c, promise) {
  if (!promise) return;
  const safe = Promise.resolve(promise).catch(() => {});
  try {
    if (c && c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(safe);
      return;
    }
  } catch {}
  // Outside Workers ExecutionContext (e.g. unit tests), let promise settle naturally.
}

export async function matchEdgeCache(deps, key) {
  const cache = getCache(deps);
  if (!cache || !key) return null;
  try {
    const hit = await cache.match(key);
    return hit || null;
  } catch {
    return null;
  }
}

export function putEdgeCache(deps, c, key, response) {
  const cache = getCache(deps);
  if (!cache || !key || !response) return;
  try {
    const cloned = response.clone();
    runBackground(c, cache.put(key, cloned));
  } catch {}
}

export async function purgeEdgeCacheForFile(deps, c, id) {
  const cache = getCache(deps);
  const origin = originOf(c, deps);
  if (!cache || !origin || !id) return;
  const tasks = [
    cache.delete(thumbCacheKey(origin, id)).catch(() => false),
    cache.delete(mediaCacheKey(origin, id)).catch(() => false),
  ];
  await Promise.all(tasks);
}

export async function purgeEdgeCacheForFiles(deps, c, ids) {
  const cache = getCache(deps);
  const origin = originOf(c, deps);
  if (!cache || !origin || !Array.isArray(ids) || !ids.length) return;
  const tasks = [];
  for (const id of ids) {
    if (!id) continue;
    tasks.push(cache.delete(thumbCacheKey(origin, id)).catch(() => false));
    tasks.push(cache.delete(mediaCacheKey(origin, id)).catch(() => false));
  }
  await Promise.all(tasks);
}

export function withCacheHeader(res, statusValue) {
  const headers = new Headers(res.headers);
  headers.set('X-RelayBox-Cache', statusValue);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Compute safe edge-cache max-age seconds for a public file/thumb.
 * Returns 0 if the item is already expired or expires within 10 seconds.
 */
export function computePublicEdgeTtl(expiresAt, defaultTtlSec = 86400, maxExpiringTtlSec = 3600) {
  if (!expiresAt) return defaultTtlSec;
  const remainSec = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(remainSec) || remainSec <= 10) return 0;
  return Math.min(maxExpiringTtlSec, remainSec);
}
