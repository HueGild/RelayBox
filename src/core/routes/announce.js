// RelayBox core routes — announcement (public read / admin write).
// Mirrors v2.8.4's handleAnnouncement + the GET /api/announcement branch.

import { readJsonBody } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';

export function registerAnnounce(app) {
  app.get('/api/announcement', async (c) => {
    const deps = c.get('deps');
    return c.json({ ok: true, announcement: await deps.meta.getAnnouncement() });
  });

  // 站点公告：POST 仅管理员，body { announcement }，空串 = 清除，最多 200 字。
  app.post('/api/announcement', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const { announcement } = await readJsonBody(c);
    const text = typeof announcement === 'string' ? announcement.trim().slice(0, 200) : '';
    await deps.meta.setAnnouncement(text);
    return c.json({ ok: true, announcement: text });
  });
}
