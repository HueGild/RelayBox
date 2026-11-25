// RelayBox core lib — Telegram real-time notification engine (v3.3.2).
// Pure Web APIs (fetch + AbortController + Web Crypto via crypto.js).
// Zero D1 migration required: stores config & daily report cursor in `settings`.

import { encryptSecret, decryptSecret } from './crypto.js';
import { isExpired, log } from './util.js';

export const SETTING_TG_NOTIFY = 'tg_notify';
export const SETTING_TG_DAILY_DATE = 'tg_daily_report_date';
const DEFAULT_API_BASE = 'https://api.telegram.org';
const TG_TIMEOUT_MS = 6000;

const DEFAULT_EVENTS = {
  dropUpload: true,
  shareConsumed: true,
  authBlocked: true,
  dailyReport: true,
};

export function escapeTgHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function maskBotToken(token) {
  const s = String(token || '').trim();
  if (!s) return '';
  const colon = s.indexOf(':');
  if (colon > 0 && s.length > colon + 6) {
    return s.slice(0, colon + 4) + '…' + s.slice(-4);
  }
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

export function normalizeApiBase(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_API_BASE;
  if (!/^https?:\/\/[^\s/]+/i.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return s;
  } catch {
    return '';
  }
}

function normalizeEvents(raw) {
  const e = (raw && typeof raw === 'object') ? raw : {};
  return {
    dropUpload: e.dropUpload !== false,
    shareConsumed: e.shareConsumed !== false,
    authBlocked: e.authBlocked !== false,
    dailyReport: e.dailyReport !== false,
  };
}

function normalizeHour(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 8;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

export async function getTelegramConfig(deps) {
  const fallback = {
    enabled: false,
    botTokenEnc: '',
    botTokenPreview: '',
    chatId: '',
    apiBase: DEFAULT_API_BASE,
    events: { ...DEFAULT_EVENTS },
    dailyReportHour: 8,
  };
  try {
    const raw = await deps.meta.getSetting(SETTING_TG_NOTIFY);
    if (!raw) return fallback;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return fallback;
    return {
      enabled: o.enabled === true,
      botTokenEnc: typeof o.botTokenEnc === 'string' ? o.botTokenEnc : '',
      botTokenPreview: typeof o.botTokenPreview === 'string' ? o.botTokenPreview : '',
      chatId: typeof o.chatId === 'string' ? o.chatId.trim() : '',
      apiBase: normalizeApiBase(o.apiBase) || DEFAULT_API_BASE,
      events: normalizeEvents(o.events),
      dailyReportHour: normalizeHour(o.dailyReportHour),
    };
  } catch {
    return fallback;
  }
}

export async function getTelegramPublicConfig(deps) {
  const cfg = await getTelegramConfig(deps);
  let lastDailyReportDate = '';
  try {
    lastDailyReportDate = (await deps.meta.getSetting(SETTING_TG_DAILY_DATE)) || '';
  } catch {}
  return {
    enabled: cfg.enabled,
    hasBotToken: !!cfg.botTokenEnc,
    botTokenPreview: cfg.botTokenPreview || '',
    chatId: cfg.chatId,
    apiBase: cfg.apiBase,
    events: cfg.events,
    dailyReportHour: cfg.dailyReportHour,
    lastDailyReportDate,
  };
}

export async function saveTelegramConfig(deps, patch) {
  const cur = await getTelegramConfig(deps);
  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    botTokenEnc: cur.botTokenEnc,
    botTokenPreview: cur.botTokenPreview,
    chatId: patch.chatId !== undefined ? String(patch.chatId || '').trim().slice(0, 64) : cur.chatId,
    apiBase: cur.apiBase,
    events: patch.events !== undefined ? normalizeEvents({ ...cur.events, ...patch.events }) : cur.events,
    dailyReportHour: patch.dailyReportHour !== undefined ? normalizeHour(patch.dailyReportHour) : cur.dailyReportHour,
  };
  if (patch.apiBase !== undefined) {
    const base = normalizeApiBase(patch.apiBase);
    if (!base) return { ok: false, error: 'Telegram API 地址格式不对，需以 https:// 开头' };
    next.apiBase = base;
  }
  if (patch.clearBotToken === true) {
    next.botTokenEnc = '';
    next.botTokenPreview = '';
  } else if (typeof patch.botToken === 'string' && patch.botToken.trim()) {
    const plain = patch.botToken.trim().slice(0, 128);
    next.botTokenEnc = await encryptSecret(plain, deps.config.uploadPassword);
    next.botTokenPreview = maskBotToken(plain);
  }
  if (next.enabled && (!next.botTokenEnc || !next.chatId)) {
    return { ok: false, error: '开启推送前请先填写 Bot Token 和 Chat ID' };
  }
  await deps.meta.setSetting(SETTING_TG_NOTIFY, JSON.stringify(next));
  return { ok: true, config: await getTelegramPublicConfig(deps) };
}

/** Non-blocking execution helper: uses CF waitUntil when present, never throws. */
export function dispatchNotify(c, promiseFactory) {
  let p;
  try {
    p = Promise.resolve().then(promiseFactory).catch((e) => {
      log('telegram notify error:', e && e.message);
    });
  } catch (e) {
    log('telegram notify sync error:', e && e.message);
    return;
  }
  try {
    const ctx = c && c.executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  } catch {
    // Hono throws accessing c.executionCtx outside Cloudflare Workers (Node/tests)
  }
}

/**
 * Send an HTML-formatted message to Telegram Bot API.
 * Never throws; returns { ok: true } or { ok: false, error }.
 */
export async function sendTelegramMessage(deps, text, override) {
  try {
    const cfg = await getTelegramConfig(deps);
    const hasOverrideToken = override && typeof override.botToken === 'string' && override.botToken.trim();
    const token = hasOverrideToken
      ? override.botToken.trim()
      : (cfg.botTokenEnc ? await decryptSecret(cfg.botTokenEnc, deps.config.uploadPassword) : '');
    const chatId = (override && typeof override.chatId === 'string' && override.chatId.trim())
      ? override.chatId.trim()
      : cfg.chatId;
    const apiBase = (override && override.apiBase !== undefined)
      ? (normalizeApiBase(override.apiBase) || DEFAULT_API_BASE)
      : (cfg.apiBase || DEFAULT_API_BASE);

    if (!token || !chatId) {
      return { ok: false, error: '未配置 Bot Token 或 Chat ID' };
    }

    const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${apiBase}/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text || '').slice(0, 4000),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok || (data && data.ok === false)) {
        const desc = (data && data.description) ? data.description : `HTTP ${res.status}`;
        return { ok: false, error: desc };
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? '请求超时' : ((e && e.message) || '网络异常');
    return { ok: false, error: msg };
  }
}

function formatCstTime(nowMs) {
  const d = new Date((nowMs || Date.now()) + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC+8)`;
}

export function cstDateAndHour(nowMs) {
  const d = new Date((nowMs || Date.now()) + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { dateStr, hour: d.getUTCHours() };
}

export function notifyDropUpload(deps, c, info) {
  dispatchNotify(c, async () => {
    const cfg = await getTelegramConfig(deps);
    if (!cfg.enabled || !cfg.events.dropUpload) return;
    const quota = info.maxFiles > 0 ? `${info.usedFiles} / ${info.maxFiles} 份` : `第 ${info.usedFiles} 份`;
    const lines = [
      '📥 <b>RelayBox 收集箱收到新文件</b>',
      `收集箱：<b>${escapeTgHtml(info.dropTitle || '文件收集')}</b>`,
      `文件名：<code>${escapeTgHtml(info.fileName || '')}</code>`,
      `大小：${fmtBytes(info.size)} · 目录：${escapeTgHtml(info.folderName || '根目录')}`,
      `进度：${quota}`,
    ];
    if (info.ip) {
      lines.push(`来源：<code>${escapeTgHtml(info.ip)}</code>${info.geo ? ' · ' + escapeTgHtml(info.geo) : ''}`);
    }
    lines.push(`时间：${formatCstTime()}`);
    await sendTelegramMessage(deps, lines.join('\n'));
  });
}

export function notifyShareConsumed(deps, c, info) {
  dispatchNotify(c, async () => {
    const cfg = await getTelegramConfig(deps);
    if (!cfg.enabled || !cfg.events.shareConsumed) return;
    const kindLabel = info.burn ? '🔥 分享链接已阅后即焚' : '🏁 分享链接下载次数已用完';
    const lines = [
      `<b>${kindLabel}</b>`,
      `${info.isFolder ? '文件夹' : '文件'}：<code>${escapeTgHtml(info.targetName || '')}</code>`,
      info.burn
        ? '状态：已自动焚毁失效'
        : `下载计数：${info.usedDownloads} / ${info.maxDownloads} 次`,
    ];
    if (info.ip) {
      lines.push(`下载者：<code>${escapeTgHtml(info.ip)}</code>${info.geo ? ' · ' + escapeTgHtml(info.geo) : ''}`);
    }
    lines.push(`时间：${formatCstTime()}`);
    await sendTelegramMessage(deps, lines.join('\n'));
  });
}

export function notifyAuthBlocked(deps, c, info) {
  dispatchNotify(c, async () => {
    const cfg = await getTelegramConfig(deps);
    if (!cfg.enabled || !cfg.events.authBlocked) return;
    const lines = [
      '🚨 <b>RelayBox 安全告警：IP 已触发封禁</b>',
      `入口：${escapeTgHtml(info.source || '密码校验')}`,
      `来源 IP：<code>${escapeTgHtml(info.ip || 'unknown')}</code>${info.geo ? ' · ' + escapeTgHtml(info.geo) : ''}`,
      '策略：10 分钟内连续试错 5 次，已自动封禁 10 分钟',
      `时间：${formatCstTime()}`,
    ];
    await sendTelegramMessage(deps, lines.join('\n'));
  });
}

export async function buildDailyReportMessage(deps, poolSummary, nowMs) {
  const [fileSummary, folders, drops] = await Promise.all([
    deps.meta.getActiveFileSummary(),
    deps.meta.listFolders(),
    typeof deps.meta.listDropLinks === 'function' ? deps.meta.listDropLinks() : Promise.resolve([]),
  ]);
  const { dateStr } = cstDateAndHour(nowMs);
  const lines = [
    `📊 <b>RelayBox 每日存储汇总（${dateStr}）</b>`,
    `文件总数：<b>${fileSummary.count}</b> 个（总计 ${fmtBytes(fileSummary.totalBytes)}）`,
    `文件夹：${(folders || []).length} 个 · 收集箱：${(drops || []).length} 个`,
    '',
    '<b>存储池用量：</b>',
  ];
  const pools = (poolSummary && Array.isArray(poolSummary.pools)) ? poolSummary.pools : [];
  if (!pools.length) {
    lines.push('• 暂无存储池数据');
  } else {
    for (const p of pools) {
      const used = p.usedBytes || 0;
      const quota = p.quotaBytes || 0;
      const pct = quota > 0 ? ((used / quota) * 100).toFixed(1) + '%' : '-';
      const status = p.enabled === false ? ' [已停用]' : (p.isDefault ? ' [默认]' : '');
      lines.push(`• <b>${escapeTgHtml(p.name)}</b>${status}：${fmtBytes(used)}${quota > 0 ? ' / ' + fmtBytes(quota) + ` (${pct})` : ''}`);
    }
  }
  lines.push('', `统计时间：${formatCstTime(nowMs)}`);
  return lines.join('\n');
}

/**
 * Triggered inside scheduled/periodic cleanup.
 * Sends at most once per Beijing calendar day at or after `dailyReportHour`.
 */
export async function maybeSendDailyReport(deps, getPoolSummary, nowMs) {
  try {
    const cfg = await getTelegramConfig(deps);
    if (!cfg.enabled || !cfg.events.dailyReport) return { sent: false, reason: 'disabled' };
    const { dateStr, hour } = cstDateAndHour(nowMs);
    if (hour < cfg.dailyReportHour) return { sent: false, reason: 'before_hour' };
    const lastDate = await deps.meta.getSetting(SETTING_TG_DAILY_DATE);
    if (lastDate === dateStr) return { sent: false, reason: 'already_sent' };

    const poolSummary = typeof getPoolSummary === 'function' ? await getPoolSummary() : { pools: [] };
    const text = await buildDailyReportMessage(deps, poolSummary, nowMs);
    const out = await sendTelegramMessage(deps, text);
    if (out.ok) {
      await deps.meta.setSetting(SETTING_TG_DAILY_DATE, dateStr);
      log('telegram daily report sent:', dateStr);
      return { sent: true, dateStr };
    }
    log('telegram daily report failed:', out.error);
    return { sent: false, error: out.error };
  } catch (e) {
    log('maybeSendDailyReport error:', e && e.message);
    return { sent: false, error: e && e.message };
  }
}
