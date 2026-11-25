// RelayBox core routes — lightweight storage & access statistics dashboard (v3.5.0).
// Pure Web APIs, backed by D1 native SQL GROUP BY / ORDER BY queries.

import { isAuthed } from '../lib/auth.js';
import { buildPoolSummaries } from './pools.js';

export function registerStats(app) {
  app.get('/api/stats', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const now = Date.now();
    const [stats, poolSummary] = await Promise.all([
      deps.meta.getDashboardStats(now),
      buildPoolSummaries(deps, null, { authed: true, includeAdminMeta: false }),
    ]);
    return c.json({
      ok: true,
      generatedAt: new Date(now).toISOString(),
      overview: stats.overview,
      byKind: stats.byKind,
      topDownloads: stats.topDownloads,
      uploadTrend7d: stats.uploadTrend7d,
      pools: poolSummary.pools,
    });
  });
}
