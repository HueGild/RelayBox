// RelayBox core routes — Telegram notification management (v3.3.2, admin-only).

import { readJsonBody, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import {
  getTelegramPublicConfig,
  saveTelegramConfig,
  sendTelegramMessage,
  buildDailyReportMessage,
  escapeTgHtml,
} from '../lib/notify.js';
import { buildPoolSummaries } from './pools.js';

export function registerNotify(app) {
  app.get('/api/notify/telegram', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const config = await getTelegramPublicConfig(deps);
    return c.json({ ok: true, config });
  });

  app.put('/api/notify/telegram', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const res = await saveTelegramConfig(deps, body);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
    log('telegram notify settings updated: enabled =', res.config.enabled);
    return c.json({ ok: true, config: res.config });
  });

  app.post('/api/notify/telegram/test', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const origin = new URL(c.req.url).origin;
    const text = [
      '✅ <b>RelayBox Telegram 推送测试成功</b>',
      `站点：<code>${escapeTgHtml(origin)}</code>`,
      '后续收集箱来件、阅后即焚、密码告警与每日用量汇总都将实时推送到这里。',
    ].join('\n');
    const out = await sendTelegramMessage(deps, text, {
      botToken: typeof body.botToken === 'string' ? body.botToken : '',
      chatId: typeof body.chatId === 'string' ? body.chatId : '',
      apiBase: body.apiBase !== undefined ? body.apiBase : undefined,
    });
    if (!out.ok) return c.json({ ok: false, error: '发送失败：' + out.error }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/notify/telegram/daily-report', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const summary = await buildPoolSummaries(deps, allFiles, { authed: true, includeAdminMeta: false });
    const text = await buildDailyReportMessage(deps, summary);
    const out = await sendTelegramMessage(deps, text, {
      botToken: typeof body.botToken === 'string' ? body.botToken : '',
      chatId: typeof body.chatId === 'string' ? body.chatId : '',
      apiBase: body.apiBase !== undefined ? body.apiBase : undefined,
    });
    if (!out.ok) return c.json({ ok: false, error: '推送失败：' + out.error }, 400);
    return c.json({ ok: true });
  });
}
