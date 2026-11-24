// RelayBox core routes — runtime settings (v3.1.6: adaptive R2 transfer mode).
// Supports 'presign' (direct to R2 via presigned URL) and 'proxy' (Worker R2
// binding streaming relay, zero S3 credentials / zero CORS required).

import { readJsonBody, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';

export const SETTING_R2_TRANSFER_MODE = 'r2_transfer_mode';

/**
 * Resolve effective R2 transfer mode and runtime capabilities.
 * - VPS (proxySupported === false): always 'presign'.
 * - CF without S3 secrets (presignEnabled === false): auto-degrades to 'proxy'.
 * - CF with both binding and S3 secrets: honors saved DB setting, else config default ('presign').
 */
export async function getTransferModeState(deps) {
  const presignAvailable = !!(deps.r2 && deps.r2.presignEnabled);
  const proxyAvailable = !!(deps.r2 && deps.r2.proxySupported);
  let saved = null;
  try {
    const raw = await deps.meta.getSetting(SETTING_R2_TRANSFER_MODE);
    if (raw === 'presign' || raw === 'proxy') saved = raw;
  } catch { /* ignore */ }
  const envDefault = (deps.config && deps.config.defaultTransferMode === 'proxy') ? 'proxy' : 'presign';

  let mode = 'presign';
  if (!proxyAvailable) {
    mode = 'presign';
  } else if (!presignAvailable) {
    mode = 'proxy';
  } else if (saved) {
    mode = saved;
  } else {
    mode = envDefault;
  }

  return { mode, savedMode: saved, presignAvailable, proxyAvailable };
}

export function registerSettings(app) {
  app.get('/api/settings', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const state = await getTransferModeState(deps);
    return c.json({
      ok: true,
      r2TransferMode: state.mode,
      savedMode: state.savedMode,
      presignAvailable: state.presignAvailable,
      proxyAvailable: state.proxyAvailable,
    });
  });

  app.post('/api/settings', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const mode = body.r2TransferMode;
    if (mode !== 'presign' && mode !== 'proxy') {
      return c.json({ ok: false, error: 'r2TransferMode 只能是 presign 或 proxy' }, 400);
    }
    const state = await getTransferModeState(deps);
    if (mode === 'presign' && !state.presignAvailable) {
      return c.json({ ok: false, error: '当前未配置 R2 S3 密钥，无法切换到预签名直传模式' }, 400);
    }
    if (mode === 'proxy' && !state.proxyAvailable) {
      return c.json({ ok: false, error: '当前部署环境不支持 Worker 绑定中转模式' }, 400);
    }
    await deps.meta.setSetting(SETTING_R2_TRANSFER_MODE, mode);
    log('settings updated: r2_transfer_mode ->', mode);
    const next = await getTransferModeState(deps);
    return c.json({
      ok: true,
      r2TransferMode: next.mode,
      savedMode: next.savedMode,
      presignAvailable: next.presignAvailable,
      proxyAvailable: next.proxyAvailable,
    });
  });
}
