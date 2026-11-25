// RelayBox core routes — API tokens (v3.1, geek one-click upload auth).
// Admin-only management: list / create / revoke. The plaintext token is
// returned exactly once, at creation; only its SHA-256 hash is stored.

import { readJsonBody, newId, newApiToken, sha256Hex } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';

export function registerTokens(app) {
  // Token 列表（管理员）：只返回可展示字段，不含明文与哈希。
  app.get('/api/tokens', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const tokens = await deps.meta.listApiTokens();
    return c.json({ ok: true, tokens });
  });

  // 新建 Token（管理员）：生成 rbx_+32 位 hex，SHA-256 存库，明文仅本次返回。
  app.post('/api/tokens', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const name = (typeof body.name === 'string' && body.name.trim())
      ? body.name.trim().slice(0, 64) : 'API Token';
    const scope = body.scope === 'all' ? 'all' : 'upload';
    const token = newApiToken();
    const tokenHash = await sha256Hex(token);
    const item = await deps.meta.createApiToken({
      id: newId(),
      name,
      tokenHash,
      prefix: token.slice(0, 8),
      scope,
      createdAt: Date.now(),
    });
    await recordAudit(deps, c, 'token_create', name, `scope=${scope}`);
    return c.json({ ok: true, token, ...item });
  });

  // 吊销 Token（管理员）：立即失效。
  app.delete('/api/tokens/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    await deps.meta.deleteApiToken(id);
    await recordAudit(deps, c, 'token_revoke', id, '吊销 API 密钥');
    return c.json({ ok: true });
  });
}
