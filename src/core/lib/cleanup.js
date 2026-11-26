// RelayBox core lib — expiry + 7-day trash + stale-chunk cleanup (v3.3.6).

import { isExpired, log, CHUNK_TTL_MS } from './util.js';
import { resolveUploadTarget, buildPoolSummaries } from '../routes/pools.js';
import { trashTtlMsOf, isTrashExpired, purgeFilePermanently } from '../routes/trash.js';
import { maybeSendDailyReport } from './notify.js';
import { runScheduledGithubWatches } from '../routes/github.js';

export async function cleanupExpired(deps) {
  const ttlMs = trashTtlMsOf(deps);
  const now = Date.now();
  const [expired, trashExpired] = await Promise.all([
    deps.meta.listExpiredFiles(now),
    deps.meta.listTrashExpiredFiles(now - ttlMs),
  ]);

  for (const f of expired) {
    try {
      await purgeFilePermanently(deps, f);
      log('expired file removed:', f.name);
    } catch (e) {
      log('expired delete failed:', f.name, e && e.message);
    }
  }
  for (const f of trashExpired) {
    try {
      await purgeFilePermanently(deps, f);
      log('trash expired file purged:', f.name);
    } catch (e) {
      log('trash purge failed:', f.name, e && e.message);
    }
  }

  await deps.meta.deleteExpiredSessions(now);
  if (typeof deps.meta.deleteExpiredShares === 'function') {
    await deps.meta.deleteExpiredShares(now);
  }
  if (typeof deps.meta.deleteExpiredDropLinks === 'function') {
    await deps.meta.deleteExpiredDropLinks(now);
  }
  if (typeof deps.meta.deleteOldAuditLogs === 'function') {
    await deps.meta.deleteOldAuditLogs(now - 30 * 24 * 3600 * 1000);
  }
  await cleanupChunks(deps);
  await runScheduledGithubWatches(deps);
  await maybeSendDailyReport(deps, async () => (
    buildPoolSummaries(deps, null, { authed: true, includeAdminMeta: false })
  ));
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
