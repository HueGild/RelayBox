// RelayBox core routes — auth (login / logout / me).
// Mirrors v2.8.4's handleLogin / handleLogout / /api/me exactly.

import { readJsonBody } from '../lib/util.js';
import { recordAudit } from '../lib/audit.js';
import { isAuthed, newSession, isBlocked, recordPasswordResult, setSessionCookie, clearSessionCookie, sessionTokenOf, clientIp } from '../lib/auth.js';

export function registerAuth(app) {
  // 管理员登录：账号 admin，密码就是上传密码。防爆破：同一 IP 10 分钟内错 5 次封 10 分钟。
  app.post('/api/login', async (c) => {
    const deps = c.get('deps');
    const { username, password } = await readJsonBody(c);
    const ip = clientIp(c, deps);
    if (await isBlocked(deps, ip)) {
      await recordAudit(deps, c, 'login_blocked', 'admin', 'IP 尝试次数超限被拦截');
      return c.json({ ok: false, error: '尝试太频繁，10 分钟后再试' }, 429);
    }
    if (username !== 'admin' || password !== deps.config.uploadPassword) {
      await recordPasswordResult(deps, ip, false, c, '管理员登录');
      return c.json({ ok: false, error: '账号或密码不对' }, 401);
    }
    await recordPasswordResult(deps, ip, true);
    const token = await newSession(deps);
    setSessionCookie(c, token);
    await recordAudit(deps, c, 'login', 'admin', '管理员登录成功');
    return c.json({ ok: true, username: 'admin' });
  });

  app.post('/api/logout', async (c) => {
    const deps = c.get('deps');
    const token = sessionTokenOf(c);
    if (token) await deps.meta.deleteSession(token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get('/api/me', async (c) => {
    const deps = c.get('deps');
    const authed = await isAuthed(c, deps);
    return c.json({ ok: true, authed, username: authed ? 'admin' : '' });
  });
}
