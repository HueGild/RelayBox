// RelayBox core routes — security & admin audit logs viewer (v3.6.0).

import { isAuthed } from '../lib/auth.js';

export function registerAudit(app) {
  app.get('/api/audit', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const rawLimit = Number(c.req.query('limit'));
    const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(200, Math.floor(rawLimit)) : 100;
    const action = (c.req.query('action') || '').trim();
    const logs = (typeof deps.meta.listAuditLogs === 'function')
      ? await deps.meta.listAuditLogs({ limit, action })
      : [];
    return c.json({ ok: true, logs, retentionDays: 30 });
  });
}
