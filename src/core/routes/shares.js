// RelayBox core routes — shares (file/folder share links + public share info).
// v3.8.0: supports sub-account subtree sandboxing, canShare permission, and audit logging.

import { readJsonBody, folderIdOf, folderPath, isExpired, newToken, newPickupCode, log } from '../lib/util.js';
import { isAuthed, getAuthContext, assertFolderInSubtree, auditUserPrefix, isBlocked, clientIp, recordFailureWithAlert } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';

/** 分享对象（管理员/子账号接口用）：新旧字段并存，旧前端只读它认识的字段。 */
function shareView(share) {
  return {
    token: share.token, code: share.code || null, burn: !!share.burn,
    pickupCode: share.pickupCode || null,
    maxDownloads: typeof share.maxDownloads === 'number' ? share.maxDownloads : 0,
    usedDownloads: typeof share.usedDownloads === 'number' ? share.usedDownloads : 0,
    expiresAt: share.expiresAt || null,
  };
}

/** 分享页展示用的限次与有效期信息（不含明文提取码）。 */
function shareLimitView(share) {
  return {
    pickupCode: share.pickupCode || null,
    maxDownloads: typeof share.maxDownloads === 'number' ? share.maxDownloads : 0,
    usedDownloads: typeof share.usedDownloads === 'number' ? share.usedDownloads : 0,
    burn: !!share.burn,
    expiresAt: share.expiresAt || null,
  };
}

/** Parse independent share expiry from body (expiresHours: 0=permanent, >0=hours; or expiresAt: ISO/null). */
function parseShareExpiryInput(body) {
  if (!body || typeof body !== 'object') return { provided: false, expiresAt: null };
  if (body.expiresHours !== undefined) {
    const h = Number(body.expiresHours);
    if (!Number.isFinite(h) || h <= 0) return { provided: true, expiresAt: null };
    const clamped = Math.min(8760, h);
    return { provided: true, expiresAt: new Date(Date.now() + clamped * 3600 * 1000).toISOString() };
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null || body.expiresAt === '') return { provided: true, expiresAt: null };
    const ms = new Date(body.expiresAt).getTime();
    if (!Number.isFinite(ms)) return { provided: true, expiresAt: null };
    return { provided: true, expiresAt: new Date(ms).toISOString() };
  }
  return { provided: false, expiresAt: null };
}

/**
 * 生成一个未被占用的 5 位取件码：先查库确认未占用，唯一索引冲突时
 * （并发）最多重试 3 次；3 次都失败返回 null，调用方创建无码分享。
 */
async function generateUniquePickupCode(deps) {
  for (let i = 0; i < 3; i++) {
    const code = newPickupCode();
    const existing = await deps.meta.getShareByPickupCode(code);
    if (!existing) return code;
  }
  return null;
}

export function registerShares(app) {
  // 读分享设置：主管理员不限；子账号校验目标在子树内。
  async function handleGetShare(c, id, isFolder) {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin) {
      const target = isFolder ? await deps.meta.getFolder(id) : await deps.meta.getFile(id);
      if (!target || (!isFolder && target.deletedAt)) return c.json({ ok: false, error: isFolder ? '文件夹不存在' : '文件不存在' }, 404);
      const checkFid = isFolder ? target.id : folderIdOf(target);
      if (!(await assertFolderInSubtree(deps, checkFid, authCtx.user.rootFolderId))) {
        return c.json({ ok: false, error: '无权访问该对象的分享设置' }, 403);
      }
    }
    const share = isFolder
      ? await deps.meta.getShareByFolderId(id)
      : await deps.meta.getShareByFileId(id);
    if (!share) return c.json({ ok: true, share: null });
    return c.json({ ok: true, share: shareView(share) });
  }

  // 生成（或返回已有的）分享链接：子账号需 canShare 且目标在子树内。
  async function handleCreateShare(c, id, isFolder) {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin && !authCtx.user.canShare) {
      return c.json({ ok: false, error: '当前账号没有分享权限' }, 403);
    }
    const target = isFolder
      ? await deps.meta.getFolder(id)
      : await deps.meta.getFile(id);
    if (!target || (!isFolder && target.deletedAt)) return c.json({ ok: false, error: isFolder ? '文件夹不存在' : '文件不存在' }, 404);
    if (!authCtx.isAdmin) {
      const checkFid = isFolder ? target.id : folderIdOf(target);
      if (!(await assertFolderInSubtree(deps, checkFid, authCtx.user.rootFolderId))) {
        return c.json({ ok: false, error: '无权分享该目录外的内容' }, 403);
      }
    }
    const body = await readJsonBody(c);
    const hasCode = typeof body.code === 'string';
    const code = hasCode ? body.code.trim().slice(0, 32) : '';
    const hasBurn = typeof body.burn === 'boolean';
    const burn = body.burn === true;
    const hasMaxDownloads = typeof body.maxDownloads === 'number'
      && Number.isFinite(body.maxDownloads) && body.maxDownloads >= 0;
    const maxDownloads = hasMaxDownloads ? Math.floor(body.maxDownloads) : null;
    const expiryInput = parseShareExpiryInput(body);
    const getExisting = isFolder
      ? deps.meta.getShareByFolderId(id)
      : deps.meta.getShareByFileId(id);
    let share = await getExisting;
    if (!share) {
      let newBurn = false;
      let newMaxDownloads = 0;
      if (hasMaxDownloads) {
        newMaxDownloads = maxDownloads;
        newBurn = maxDownloads === 1;
      } else if (hasBurn && burn) {
        newMaxDownloads = 1;
        newBurn = true;
      }
      const pickupCode = await generateUniquePickupCode(deps);
      const fresh = {
        token: newToken(),
        ...(isFolder ? { folderId: id } : { fileId: id }),
        createdAt: new Date().toISOString(),
        maxDownloads: newMaxDownloads,
        usedDownloads: 0,
        burn: newBurn,
        pickupCode,
        expiresAt: expiryInput.provided ? expiryInput.expiresAt : null,
      };
      try {
        share = await deps.meta.createShare(fresh);
      } catch (e) {
        if (!/UNIQUE/i.test((e && e.message) || '')) throw e;
        const retryCode = await generateUniquePickupCode(deps);
        share = await deps.meta.createShare({ ...fresh, pickupCode: retryCode });
      }
    }
    const patch = {};
    if (hasCode) patch.code = code;
    if (hasMaxDownloads) {
      patch.maxDownloads = maxDownloads;
      patch.burn = maxDownloads === 1;
    } else if (hasBurn) {
      patch.burn = burn;
      if (burn) patch.maxDownloads = 1;
      else if (share.maxDownloads === 1) patch.maxDownloads = 0;
    }
    if (expiryInput.provided) patch.expiresAt = expiryInput.expiresAt;
    if (!share.pickupCode) {
      const backfill = await generateUniquePickupCode(deps);
      if (backfill) patch.pickupCode = backfill;
    }
    if (hasCode || hasBurn || hasMaxDownloads || expiryInput.provided || patch.pickupCode) {
      share = await deps.meta.updateShare(share.token, patch);
    }
    if (!authCtx.isAdmin) {
      await recordAudit(deps, c, 'share_create', target.name, `${auditUserPrefix(authCtx)}${isFolder ? 'folder' : 'file'} token=${share.token}`);
    }
    log(isFolder ? 'folder share created:' : 'share created:', target.name, share.token, share.code ? '(有提取码)' : '', share.burn ? '(阅后即焚)' : '', share.maxDownloads ? `(限 ${share.maxDownloads} 次)` : '');
    return c.json({ ok: true, ...shareView(share) });
  }

  // 取消分享：子账号需 canShare 且目标在子树内。
  async function handleRevokeShare(c, id, isFolder) {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin) {
      if (!authCtx.user.canShare) return c.json({ ok: false, error: '当前账号没有分享权限' }, 403);
      const target = isFolder ? await deps.meta.getFolder(id) : await deps.meta.getFile(id);
      if (target) {
        const checkFid = isFolder ? target.id : folderIdOf(target);
        if (!(await assertFolderInSubtree(deps, checkFid, authCtx.user.rootFolderId))) {
          return c.json({ ok: false, error: '无权取消该目录外的分享' }, 403);
        }
      }
    }
    const share = isFolder
      ? await deps.meta.getShareByFolderId(id)
      : await deps.meta.getShareByFileId(id);
    if (share) await deps.meta.deleteShare(share.token);
    if (!authCtx.isAdmin) {
      await recordAudit(deps, c, 'share_revoke', id, `${auditUserPrefix(authCtx)}${isFolder ? 'folder' : 'file'}`);
    }
    log(isFolder ? 'folder share revoked:' : 'share revoked for file:', id);
    return c.json({ ok: true });
  }

  app.get('/api/files/:id/share', (c) => handleGetShare(c, decodeURIComponent(c.req.param('id')), false));
  app.post('/api/files/:id/share', (c) => handleCreateShare(c, decodeURIComponent(c.req.param('id')), false));
  app.delete('/api/files/:id/share', (c) => handleRevokeShare(c, decodeURIComponent(c.req.param('id')), false));
  app.get('/api/folders/:id/share', (c) => handleGetShare(c, decodeURIComponent(c.req.param('id')), true));
  app.post('/api/folders/:id/share', (c) => handleCreateShare(c, decodeURIComponent(c.req.param('id')), true));
  app.delete('/api/folders/:id/share', (c) => handleRevokeShare(c, decodeURIComponent(c.req.param('id')), true));

  // 全站分享管理汇总接口（仅主管理员，v3.3.10）：一屏列出所有文件/文件夹分享、剩余次数、取件码与状态。
  app.get('/api/shares', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const [shares, folders] = await Promise.all([
      typeof deps.meta.listShares === 'function' ? deps.meta.listShares() : Promise.resolve([]),
      deps.meta.listFolders(),
    ]);
    const fileIds = [...new Set((shares || []).filter((s) => s && s.fileId).map((s) => s.fileId))];
    const files = fileIds.length ? await deps.meta.getFilesByIds(fileIds) : [];
    const folderMap = new Map((folders || []).map((f) => [f.id, f]));
    const fileMap = new Map((files || []).map((f) => [f.id, f]));
    const list = (shares || []).filter((s) => s && s.token).map((s) => {
      const isFolder = !!s.folderId;
      const targetId = isFolder ? s.folderId : s.fileId;
      const target = isFolder ? folderMap.get(targetId) : fileMap.get(targetId);
      const maxDownloads = typeof s.maxDownloads === 'number' ? s.maxDownloads : (s.burn ? 1 : 0);
      const usedDownloads = typeof s.usedDownloads === 'number' ? s.usedDownloads : 0;
      const remainingDownloads = maxDownloads > 0 ? Math.max(0, maxDownloads - usedDownloads) : null;
      let status = 'active';
      if (!target) {
        status = 'missing';
      } else if (isExpired(s) || (!isFolder && isExpired(target))) {
        status = 'expired';
      } else if (maxDownloads > 0 && usedDownloads >= maxDownloads) {
        status = 'exhausted';
      }
      return {
        token: s.token,
        type: isFolder ? 'folder' : 'file',
        targetId: targetId || null,
        targetName: target ? target.name : (isFolder ? '（文件夹已删除）' : '（文件已删除或移入回收站）'),
        targetSize: (!isFolder && target) ? (target.size || 0) : null,
        targetKind: (!isFolder && target) ? (target.kind || 'file') : null,
        targetVisibility: (!isFolder && target) ? (target.visibility || 'public') : null,
        targetExpiresAt: (!isFolder && target) ? (target.expiresAt || null) : null,
        expiresAt: s.expiresAt || null,
        code: s.code || null,
        burn: !!s.burn,
        pickupCode: s.pickupCode || null,
        maxDownloads,
        usedDownloads,
        remainingDownloads,
        createdAt: s.createdAt || null,
        status,
      };
    });
    list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const counts = {
      all: list.length,
      active: list.filter((x) => x.status === 'active').length,
      inactive: list.filter((x) => x.status !== 'active').length,
    };
    return c.json({ ok: true, shares: list, counts });
  });

  // 按 token 直接吊销分享（仅主管理员，v3.3.10，兼容目标文件/文件夹已删除的孤立分享清理）。
  app.delete('/api/shares/:token', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const token = decodeURIComponent(c.req.param('token'));
    await deps.meta.deleteShare(token);
    log('share revoked by token:', token);
    return c.json({ ok: true });
  });

  // 分享页取信息（公开接口）
  app.get('/api/share/:token', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const subFolderId = c.req.query('folderId') || '';
    const code = c.req.query('code') || '';
    const share = await deps.meta.getShareByToken(token);
    if (!share) return c.json({ ok: false, error: '分享链接不存在或已被取消' }, 404);
    if (isExpired(share)) return c.json({ ok: false, error: '分享链接已过期', expired: true }, 410);
    if (share.code && (code || '') !== share.code) {
      return c.json({ ok: false, error: '提取码不正确', needCode: true }, 403);
    }
    const folders = await deps.meta.listFolders();
    if (share.folderId) {
      const root = folders.find((f) => f.id === share.folderId);
      if (!root) return c.json({ ok: false, error: '文件夹不存在' }, 404);
      const cur = subFolderId || share.folderId;
      let ok = cur === share.folderId;
      if (!ok) {
        let node = folders.find((f) => f.id === cur);
        const seen = new Set();
        while (node && !seen.has(node.id)) {
          seen.add(node.id);
          if ((node.parentId || null) === share.folderId) { ok = true; break; }
          node = folders.find((f) => f.id === (node.parentId || null));
        }
      }
      if (!ok) return c.json({ ok: false, error: '文件夹不存在' }, 404);
      const curFolder = folders.find((f) => f.id === cur);
      const folderFiles = await deps.meta.listFiles(cur, { authed: true });
      const files = folderFiles
        .map((f) => ({
          id: f.id, name: f.name, size: f.size, ext: f.ext, kind: f.kind,
          uploadedAt: f.uploadedAt, visibility: f.visibility,
          expiresAt: f.expiresAt || null, downloads: f.downloads || 0,
        }));
      const subfolders = folders
        .filter((fd) => (fd.parentId || null) === cur)
        .map((fd) => ({ id: fd.id, name: fd.name, parentId: fd.parentId || null, createdAt: fd.createdAt }));
      const chain = folderPath(folders, cur);
      const rootIdx = chain.findIndex((x) => x.id === share.folderId);
      const path = rootIdx >= 0 ? chain.slice(rootIdx) : [{ id: share.folderId, name: root.name }];
      return c.json({
        ok: true,
        folder: { id: root.id, name: root.name },
        current: { id: cur, name: curFolder ? curFolder.name : root.name },
        files, folders: subfolders, path,
        share: shareLimitView(share),
      });
    }
    const item = await deps.meta.getFile(share.fileId);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (isExpired(item)) return c.json({ ok: false, error: '文件已过期' }, 404);
    return c.json({
      ok: true,
      file: {
        id: item.id, name: item.name, size: item.size, ext: item.ext, kind: item.kind,
        uploadedAt: item.uploadedAt, visibility: item.visibility,
        expiresAt: item.expiresAt || null, downloads: item.downloads || 0,
      },
      share: shareLimitView(share),
    });
  });

  // 5 位短取件码取件（公开接口，v3.1）
  app.get('/api/pickup/:code', async (c) => {
    const deps = c.get('deps');
    const ip = clientIp(c, deps);
    if (await isBlocked(deps, ip)) {
      return c.json({ ok: false, error: '尝试太频繁，10 分钟后再试' }, 429);
    }
    const code = (decodeURIComponent(c.req.param('code')) || '').trim().toUpperCase();
    if (!code) {
      await recordFailureWithAlert(deps, ip, c, '短取件码查询');
      return c.json({ ok: false, error: '取件码不存在' }, 404);
    }
    const share = await deps.meta.getShareByPickupCode(code);
    if (!share) {
      await recordFailureWithAlert(deps, ip, c, '短取件码查询');
      return c.json({ ok: false, error: '取件码不存在' }, 404);
    }
    if (isExpired(share)) {
      return c.json({ ok: false, error: '分享链接已过期', expired: true }, 410);
    }
    return c.json({ ok: true, token: share.token, needCode: !!share.code });
  });
}
