// RelayBox core routes — runtime settings & site appearance (v3.1.6 + v3.2).
// - R2 transfer mode ('presign' | 'proxy') stored in settings table.
// - Site appearance (desktop/mobile wallpaper, overlay opacity, card blur,
//   custom brand title, logo/avatar, favicon) stored in settings table.

import { readJsonBody, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';

export const SETTING_R2_TRANSFER_MODE = 'r2_transfer_mode';
export const SETTING_SITE_APPEARANCE = 'site_appearance';

const DEFAULT_APPEARANCE = {
  siteTitle: 'RelayBox',
  siteLogo: '',
  siteFavicon: '',
  bgDesktop: '',
  bgMobile: '',
  bgOverlay: 45,
  cardBlur: 14,
};

function sanitizeImageUrl(v) {
  const s = String(v || '').trim().slice(0, 500);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeAppearance(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const title = (typeof o.siteTitle === 'string' && o.siteTitle.trim())
    ? o.siteTitle.trim().slice(0, 40)
    : DEFAULT_APPEARANCE.siteTitle;
  return {
    siteTitle: title,
    siteLogo: sanitizeImageUrl(o.siteLogo),
    siteFavicon: sanitizeImageUrl(o.siteFavicon),
    bgDesktop: sanitizeImageUrl(o.bgDesktop),
    bgMobile: sanitizeImageUrl(o.bgMobile),
    bgOverlay: clampInt(o.bgOverlay, 0, 85, DEFAULT_APPEARANCE.bgOverlay),
    cardBlur: clampInt(o.cardBlur, 0, 24, DEFAULT_APPEARANCE.cardBlur),
  };
}

export async function getAppearance(deps) {
  try {
    const raw = await deps.meta.getSetting(SETTING_SITE_APPEARANCE);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

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

  // 站点外观（公开读，管理员写）：支持双端壁纸、遮罩、毛玻璃、站点头像与 Favicon。
  app.get('/api/appearance', async (c) => {
    const deps = c.get('deps');
    const appearance = await getAppearance(deps);
    return c.json({ ok: true, appearance });
  });

  app.post('/api/appearance', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const current = await getAppearance(deps);
    const merged = normalizeAppearance({ ...current, ...body });
    await deps.meta.setSetting(SETTING_SITE_APPEARANCE, JSON.stringify(merged));
    log('appearance updated:', merged.siteTitle);
    return c.json({ ok: true, appearance: merged });
  });
}
