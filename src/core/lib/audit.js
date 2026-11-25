// RelayBox core lib — lightweight security & admin audit logger (v3.6.0).
// Pure Web APIs, zero Node deps. Always fail-safe (never blocks main flow).

import { newId } from './util.js';
import { clientMeta } from './auth.js';

export async function recordAudit(deps, c, action, target = '', detail = '') {
  if (!deps || !deps.meta || typeof deps.meta.addAuditLog !== 'function') return;
  try {
    const meta = c ? clientMeta(c, deps) : { uploadIp: '', uploadGeo: '' };
    const entry = {
      id: newId(),
      action: String(action || 'unknown').slice(0, 40),
      target: String(target || '').slice(0, 120),
      detail: String(detail || '').slice(0, 240),
      ip: String(meta.uploadIp || '').slice(0, 64),
      geo: String(meta.uploadGeo || '').slice(0, 120),
      createdAt: Date.now(),
    };
    const p = deps.meta.addAuditLog(entry).catch(() => {});
    try {
      if (c && c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
        c.executionCtx.waitUntil(p);
        return;
      }
    } catch {}
    await p;
  } catch {}
}
