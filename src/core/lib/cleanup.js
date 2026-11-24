// RelayBox core lib — expiry + stale-chunk cleanup (v3.2 pool-aware).

import { isExpired, log, CHUNK_TTL_MS } from './util.js';
import { resolveStorageForFile, resolveUploadTarget } from '../routes/pools.js';

export async function cleanupExpired(deps) {
  const list = await deps.meta.listAllFiles({ authed: true });
  const expired = list.filter(isExpired);
  if (expired.length) {
    for (const f of expired) {
      try {
        const resolved = await resolveStorageForFile(deps, f);
        if (resolved.ok) {
          try { await resolved.driver.delete(f.storageKey); } catch (e) { log('expired storage delete failed:', e && e.message); }
        } else {
          log('expired file skipped (storage unavailable):', f.storageKey);
        }
      } catch (e) { log('expired delete failed:', f.name, e && e.message); }
      try { await deps.local.deleteThumb(f.id); } catch {}
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

export async function cleanupChunks(deps) {
  try {
    const stale = await deps.meta.listStaleChunkUploads(Date.now() - CHUNK_TTL_MS);
    for (const u of stale) {
      let drv = deps.r2;
      if (u.poolId) {
        try {
          const resolved = await resolveUploadTarget(deps, u.poolId, 'r2');
          if (resolved.ok) drv = resolved.driver;
        } catch {}
      }
      await deps.meta.deleteChunkUpload(u.uploadId, drv);
      log('stale chunks removed:', u.uploadId);
    }
  } catch (e) {
    log('cleanupChunks error:', e && e.message);
  }
}
