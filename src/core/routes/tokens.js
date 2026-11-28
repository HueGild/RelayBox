// RelayBox core routes — API tokens (v3.1 + v3.9.1 on-demand AES-GCM reveal).
// Admin-only management: list / create / reveal / revoke.

import { readJsonBody, newId, newApiToken, sha256Hex } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { recordAudit } from '../lib/audit.js';

export function registerTokens(app) {
  // Token 列表（管理员）：只返回可展示字段与 hasReveal，不含明文与哈希。
  app.get('/api/tokens', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const tokens = await deps.meta.listApiTokens();
    return c.json({ ok: true, tokens });
  });

  // 新建 Token（管理员）：生成 rbx_+32 位 hex，SHA-256 哈希用于鉴权，AES-GCM 密文用于按需查看/复制。
  app.post('/api/tokens', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const name = (typeof body.name === 'string' && body.name.trim())
      ? body.name.trim().slice(0, 64) : 'API Token';
    const scope = body.scope === 'all' ? 'all' : 'upload';
    const token = newApiToken();
    const tokenHash = await sha256Hex(token);
    const tokenEnc = await encryptSecret(token, deps.config.uploadPassword);
    const item = await deps.meta.createApiToken({
      id: newId(),
      name,
      tokenHash,
      tokenEnc,
      prefix: token.slice(0, 8),
      scope,
      createdAt: Date.now(),
    });
    await recordAudit(deps, c, 'token_create', name, `scope=${scope}`);
    return c.json({ ok: true, token, ...item });
  });

  // 按需查看/复制 Token 明文（仅主管理员，解密 AES-GCM 密文并写审计日志）。
  app.get('/api/tokens/:id/reveal', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const rec = typeof deps.meta.getApiTokenById === 'function'
      ? await deps.meta.getApiTokenById(id)
      : null;
    if (!rec) return c.json({ ok: false, error: '密钥不存在' }, 404);
    if (!rec.tokenEnc) {
      return c.json({ ok: false, error: '该密钥为旧版生成（未保存密文），请删除后重新生成一条新密钥' }, 400);
    }
    let plain = '';
    try {
      plain = await decryptSecret(rec.tokenEnc, deps.config.uploadPassword);
    } catch {
      return c.json({ ok: false, error: '密钥解密失败（管理员密码可能已变更）' }, 500);
    }
    await recordAudit(deps, c, 'token_reveal', rec.name || id, '查看/复制 API 密钥');
    return c.json({ ok: true, id: rec.id, name: rec.name, scope: rec.scope, token: plain });
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
