// RelayBox core lib — expiry + stale-chunk cleanup.
// Mirrors v2.8.4's cleanupExpired / cleanupChunks (startup + every 5 minutes).

import { isExpired, log, CHUNK_TTL_MS } from './util.js';

/**
 * Delete expired files (blob + thumb + meta + their file-shares),
 * prune expired sessions, and remove stale chunk uploads.
 * Folder shares are NOT affected by single-file expiry (they have no fileId).
 */
export async function cleanupExpired(deps) {
  const list = await deps.meta.listAllFiles({ authed: true });
  const expired = list.filter(isExpired);
  if (expired.length) {
    for (const f of expired) {
      try {
        if (f.storage === 'r2') {
          if (deps.r2.enabled) {
            try { await deps.r2.delete(f.storageKey); } catch (e) { log('expired R2 delete failed:', e && e.message); }
          } else {
            log('expired R2 file skipped (R2 unavailable):', f.storageKey);
          }
        } else {
          try { await deps.local.delete(f.storageKey); } catch {}
        }
      } catch (e) { log('expired delete failed:', f.name, e && e.message); }
      try { await deps.local.deleteThumb(f.id); } catch {} // 缩略图一起删
      log('expired file removed:', f.name);
    }
    for (const f of expired) {
      await deps.meta.deleteFile(f.id);
      const share = await deps.meta.getShareByFileId(f.id);
      if (share) await deps.meta.deleteShare(share.token);
    }
  }
  await deps.meta.deleteExpiredSessions(Date.now());
  await cleanupChunks(deps);
}

/** Remove chunk uploads older than 24h (meta + part files). */
export async function cleanupChunks(deps) {
  try {
    const stale = await deps.meta.listStaleChunkUploads(Date.now() - CHUNK_TTL_MS);
    for (const u of stale) {
      await deps.meta.deleteChunkUpload(u.uploadId);
      log('stale chunks removed:', u.uploadId);
    }
  } catch (e) {
    log('cleanupChunks error:', e && e.message);
  }
}
