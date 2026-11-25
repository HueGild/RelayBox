// RelayBox core routes — shares (file/folder share links + public share info).
// Mirrors v2.8.4's handleCreateShare / handleGetShare / handleRevokeShare /
// handleCreateFolderShare / handleRevokeFolderShare / handleShareInfo exactly.

import { readJsonBody, folderIdOf, folderPath, isExpired, newToken, newPickupCode, log } from '../lib/util.js';
import { isAuthed, isBlocked, clientIp, recordFailureWithAlert } from '../lib/auth.js';

/** 分享对象（管理员接口用）：新旧字段并存，旧前端只读它认识的字段。 */
function shareView(share) {
  return {
    token: share.token, code: share.code || null, burn: !!share.burn,
    pickupCode: share.pickupCode || null,
    maxDownloads: typeof share.maxDownloads === 'number' ? share.maxDownloads : 0,
    usedDownloads: typeof share.usedDownloads === 'number' ? share.usedDownloads : 0,
  };
}

/** 分享页展示用的限次信息（不含明文提取码）。 */
function shareLimitView(share) {
  return {
    pickupCode: share.pickupCode || null,
    maxDownloads: typeof share.maxDownloads === 'number' ? share.maxDownloads : 0,
    usedDownloads: typeof share.usedDownloads === 'number' ? share.usedDownloads : 0,
    burn: !!share.burn,
  };
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
  // 读分享设置（管理员）：返回当前分享的 token、提取码、阅后即焚；没有分享时 share 为 null。
  async function handleGetShare(c, id, isFolder) {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const share = isFolder
      ? await deps.meta.getShareByFolderId(id)
      : await deps.meta.getShareByFileId(id);
    if (!share) return c.json({ ok: true, share: null });
    return c.json({ ok: true, share: shareView(share) });
  }

  // 生成（或返回已有的）分享链接（管理员）。一个文件/文件夹同时只有一个有效分享链接。
  async function handleCreateShare(c, id, isFolder) {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const target = isFolder
      ? await deps.meta.getFolder(id)
      : await deps.meta.getFile(id);
    if (!target) return c.json({ ok: false, error: isFolder ? '文件夹不存在' : '文件不存在' }, 404);
    const body = await readJsonBody(c);
    const hasCode = typeof body.code === 'string';
    const code = hasCode ? body.code.trim().slice(0, 32) : '';
    const hasBurn = typeof body.burn === 'boolean';
    const burn = body.burn === true;
    const hasMaxDownloads = typeof body.maxDownloads === 'number'
      && Number.isFinite(body.maxDownloads) && body.maxDownloads >= 0;
    const maxDownloads = hasMaxDownloads ? Math.floor(body.maxDownloads) : null;
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
    if (!share.pickupCode) {
      const backfill = await generateUniquePickupCode(deps);
      if (backfill) patch.pickupCode = backfill;
    }
    if (hasCode || hasBurn || hasMaxDownloads || patch.pickupCode) {
      share = await deps.meta.updateShare(share.token, patch);
    }
    log(isFolder ? 'folder share created:' : 'share created:', target.name, share.token, share.code ? '(有提取码)' : '', share.burn ? '(阅后即焚)' : '', share.maxDownloads ? `(限 ${share.maxDownloads} 次)` : '');
    return c.json({ ok: true, ...shareView(share) });
  }

  // 取消分享（管理员）。
  async function handleRevokeShare(c, id, isFolder) {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const share = isFolder
      ? await deps.meta.getShareByFolderId(id)
      : await deps.meta.getShareByFileId(id);
    if (share) await deps.meta.deleteShare(share.token);
    log(isFolder ? 'folder share revoked:' : 'share revoked for file:', id);
    return c.json({ ok: true });
  }

  app.get('/api/files/:id/share', (c) => handleGetShare(c, decodeURIComponent(c.req.param('id')), false));
  app.post('/api/files/:id/share', (c) => handleCreateShare(c, decodeURIComponent(c.req.param('id')), false));
  app.delete('/api/files/:id/share', (c) => handleRevokeShare(c, decodeURIComponent(c.req.param('id')), false));
  app.get('/api/folders/:id/share', (c) => handleGetShare(c, decodeURIComponent(c.req.param('id')), true));
  app.post('/api/folders/:id/share', (c) => handleCreateShare(c, decodeURIComponent(c.req.param('id')), true));
  app.delete('/api/folders/:id/share', (c) => handleRevokeShare(c, decodeURIComponent(c.req.param('id')), true));

  // 分享页取信息（公开接口）
  app.get('/api/share/:token', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const subFolderId = c.req.query('folderId') || '';
    const code = c.req.query('code') || '';
    const share = await deps.meta.getShareByToken(token);
    if (!share) return c.json({ ok: false, error: '分享链接不存在或已被取消' }, 404);
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
      const allFiles = await deps.meta.listAllFiles({ authed: true });
      const files = allFiles
        .filter((f) => folderIdOf(f) === cur && !isExpired(f))
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
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
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
    return c.json({ ok: true, token: share.token, needCode: !!share.code });
  });
}
