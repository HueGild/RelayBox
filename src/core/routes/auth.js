// RelayBox core routes — auth (login / logout / me).
// v3.8.0: supports both main admin (empty username or 'admin' + uploadPassword)
// and sub-accounts / temporary test accounts (username + PBKDF2 password).

import { readJsonBody } from '../lib/util.js';
import { recordAudit } from '../lib/audit.js';
import { verifyPassword } from '../lib/crypto.js';
import { getAuthContext, newSession, isBlocked, recordPasswordResult, setSessionCookie, clearSessionCookie, sessionTokenOf, clientIp } from '../lib/auth.js';

function publicUserInfo(user, usedBytes = 0, rootFolderName = '') {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || '',
    role: user.role === 'guest' ? 'guest' : 'user',
    rootFolderId: user.rootFolderId,
    rootFolderName: rootFolderName || '',
    quotaBytes: Number(user.quotaBytes) > 0 ? Number(user.quotaBytes) : 0,
    usedBytes: Number(usedBytes) || 0,
    canUpload: !!user.canUpload,
    canDelete: !!user.canDelete,
    canShare: !!user.canShare,
    expiresAt: user.expiresAt || null,
  };
}

export function registerAuth(app) {
  // 登录：username 为空或 'admin' 走原主管理员密码校验；传入其他 username 走子账号 PBKDF2 校验。
  app.post('/api/login', async (c) => {
    const deps = c.get('deps');
    const body = await readJsonBody(c);
    const rawUsername = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = clientIp(c, deps);
    if (await isBlocked(deps, ip)) {
      await recordAudit(deps, c, 'login_blocked', rawUsername || 'admin', 'IP 尝试次数超限被拦截');
      return c.json({ ok: false, error: '尝试太频繁，10 分钟后再试' }, 429);
    }

    // Main admin login (username omitted / empty / 'admin')
    if (!rawUsername || rawUsername === 'admin') {
      if (password !== deps.config.uploadPassword) {
        await recordPasswordResult(deps, ip, false, c, '管理员登录');
        return c.json({ ok: false, error: '账号或密码不对' }, 401);
      }
      await recordPasswordResult(deps, ip, true);
      const token = await newSession(deps, null);
      setSessionCookie(c, token);
      await recordAudit(deps, c, 'login', 'admin', '管理员登录成功');
      return c.json({ ok: true, isAdmin: true, username: 'admin', user: null });
    }

    // Sub-account / temporary test account login
    const user = (typeof deps.meta.getUserByUsername === 'function')
      ? await deps.meta.getUserByUsername(rawUsername)
      : null;
    const pwOk = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !pwOk) {
      await recordPasswordResult(deps, ip, false, c, `子账号登录(${rawUsername})`);
      return c.json({ ok: false, error: '账号或密码不对' }, 401);
    }
    if (!user.enabled) {
      await recordAudit(deps, c, 'login_denied', user.username, `[user:${user.username}] 账号已被禁用`);
      return c.json({ ok: false, error: '该账号已被禁用' }, 403);
    }
    if (user.expiresAt && user.expiresAt <= Date.now()) {
      await recordAudit(deps, c, 'login_denied', user.username, `[user:${user.username}] 账号已过期`);
      return c.json({ ok: false, error: '该账号已过期' }, 403);
    }
    await recordPasswordResult(deps, ip, true);
    if (typeof deps.meta.touchUserLogin === 'function') {
      try { await deps.meta.touchUserLogin(user.id, Date.now()); } catch {}
    }
    const token = await newSession(deps, user.id, user.expiresAt || null);
    setSessionCookie(c, token);
    const [usedBytes, rootFolder] = await Promise.all([
      typeof deps.meta.getUserUsedBytes === 'function' ? deps.meta.getUserUsedBytes(user.id) : Promise.resolve(0),
      deps.meta.getFolder(user.rootFolderId),
    ]);
    await recordAudit(deps, c, 'login', user.username, `[user:${user.username}] 登录成功 (${user.role})`);
    return c.json({
      ok: true,
      isAdmin: false,
      username: user.username,
      user: publicUserInfo(user, usedBytes, rootFolder ? rootFolder.name : ''),
    });
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
    const ctx = await getAuthContext(c, deps);
    if (!ctx.authed) {
      return c.json({ ok: true, authed: false, isAdmin: false, username: '', user: null });
    }
    if (ctx.isAdmin) {
      return c.json({ ok: true, authed: true, isAdmin: true, username: 'admin', user: null });
    }
    const [usedBytes, rootFolder] = await Promise.all([
      typeof deps.meta.getUserUsedBytes === 'function' ? deps.meta.getUserUsedBytes(ctx.user.id) : Promise.resolve(0),
      deps.meta.getFolder(ctx.user.rootFolderId),
    ]);
    return c.json({
      ok: true,
      authed: true,
      isAdmin: false,
      username: ctx.user.username,
      user: publicUserInfo(ctx.user, usedBytes, rootFolder ? rootFolder.name : ''),
    });
  });
}
