// RelayBox core routes — folders (list / create / delete / rename / move).
// v3.8.0: supports sub-account subtree sandboxing & permission bits.

import { readJsonBody, safeName, newId, log } from '../lib/util.js';
import { getAuthContext, assertFolderInSubtree } from '../lib/auth.js';

export function registerFolders(app) {
  // 全部文件夹（主管理员看全站；子账号仅看绑定根目录子树内文件夹）。
  app.get('/api/folders', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    const folders = await deps.meta.listFolders();
    if (authCtx.isAdmin) return c.json({ ok: true, folders });
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    const allowed = [];
    for (const f of folders) {
      if (await assertFolderInSubtree(deps, f.id, authCtx.user.rootFolderId, folderMap)) {
        allowed.push(f);
      }
    }
    return c.json({ ok: true, folders: allowed });
  });

  // 新建文件夹：主管理员不限；子账号需 canUpload 且父目录在子树内（默认绑定根目录）。
  app.post('/api/folders', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin && !authCtx.user.canUpload) {
      return c.json({ ok: false, error: '当前账号没有新建目录权限' }, 403);
    }
    const { name, parentId } = await readJsonBody(c);
    const folders = await deps.meta.listFolders();
    let pid = (typeof parentId === 'string' && parentId) ? parentId : null;
    if (!authCtx.isAdmin) {
      if (!pid) pid = authCtx.user.rootFolderId;
      if (!(await assertFolderInSubtree(deps, pid, authCtx.user.rootFolderId, folders))) {
        return c.json({ ok: false, error: '无权在该目录下新建文件夹' }, 403);
      }
    }
    if (pid && !folders.some((f) => f.id === pid)) return c.json({ ok: false, error: '父文件夹不存在' }, 400);
    const clean = safeName(name);
    if (!clean || clean === 'file') return c.json({ ok: false, error: '文件夹名字不对' }, 400);
    if (folders.some((f) => (f.parentId || null) === pid && f.name === clean)) {
      return c.json({ ok: false, error: '同级已有同名文件夹' }, 400);
    }
    const folder = { id: newId(), name: clean, parentId: pid, createdAt: new Date().toISOString() };
    await deps.meta.createFolder(folder);
    log('folder created:', clean);
    return c.json({ ok: true, folder });
  });

  // 删除文件夹：仅空文件夹能删；子账号需 canDelete、不能删绑定根目录本身且必须在子树内。
  app.delete('/api/folders/:id', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号没有删除权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const folders = await deps.meta.listFolders();
    const folder = folders.find((f) => f.id === id);
    if (!folder) return c.json({ ok: false, error: '文件夹不存在' }, 404);
    if (!authCtx.isAdmin) {
      if (id === authCtx.user.rootFolderId) {
        return c.json({ ok: false, error: '不能删除自己的根目录' }, 403);
      }
      if (!(await assertFolderInSubtree(deps, id, authCtx.user.rootFolderId, folders))) {
        return c.json({ ok: false, error: '无权删除该文件夹' }, 403);
      }
    }
    if (await deps.meta.hasFilesInFolder(id)) {
      return c.json({ ok: false, error: '文件夹里还有文件，先移走或删掉' }, 400);
    }
    if (folders.some((f) => (f.parentId || null) === id)) {
      return c.json({ ok: false, error: '文件夹里还有子文件夹，先移走或删掉' }, 400);
    }
    await deps.meta.deleteFolder(id);
    log('folder deleted:', id);
    return c.json({ ok: true });
  });

  // 文件夹改名：子账号需写权限、不能改绑定根目录本身且必须在子树内。
  app.post('/api/folders/:id/rename', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const { name } = await readJsonBody(c);
    const folders = await deps.meta.listFolders();
    const folder = folders.find((f) => f.id === id);
    if (!folder) return c.json({ ok: false, error: '文件夹不存在' }, 404);
    if (!authCtx.isAdmin) {
      if (id === authCtx.user.rootFolderId) {
        return c.json({ ok: false, error: '不能重命名自己的根目录' }, 403);
      }
      if (!(await assertFolderInSubtree(deps, id, authCtx.user.rootFolderId, folders))) {
        return c.json({ ok: false, error: '无权操作该文件夹' }, 403);
      }
    }
    const clean = safeName(name);
    if (!clean || clean === 'file') return c.json({ ok: false, error: '文件夹名字不对' }, 400);
    if (folders.some((f) => f.id !== id && (f.parentId || null) === (folder.parentId || null) && f.name === clean)) {
      return c.json({ ok: false, error: '同级已有同名文件夹' }, 400);
    }
    const updated = await deps.meta.updateFolder(id, { name: clean });
    return c.json({ ok: true, folder: updated });
  });

  // 移动文件夹：子账号需写权限、源与目标均在子树内、不能移动根目录本身。
  app.post('/api/folders/:id/move', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (!authCtx.isAdmin && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const { parentId } = await readJsonBody(c);
    let target = parentId || null;
    const folders = await deps.meta.listFolders();
    const folder = folders.find((f) => f.id === id);
    if (!folder) return c.json({ ok: false, error: '文件夹不存在' }, 404);
    if (!authCtx.isAdmin) {
      if (id === authCtx.user.rootFolderId) {
        return c.json({ ok: false, error: '不能移动自己的根目录' }, 403);
      }
      if (!target) target = authCtx.user.rootFolderId;
      if (!(await assertFolderInSubtree(deps, id, authCtx.user.rootFolderId, folders)) ||
          !(await assertFolderInSubtree(deps, target, authCtx.user.rootFolderId, folders))) {
        return c.json({ ok: false, error: '无权移动至目标目录' }, 403);
      }
    }
    if (target === id) return c.json({ ok: false, error: '不能把文件夹移进自己' }, 400);
    if (target) {
      const parent = folders.find((f) => f.id === target);
      if (!parent) return c.json({ ok: false, error: '目标文件夹不存在' }, 404);
      // 沿目标的父链往上走，碰到自己就是循环。
      let cur = parent;
      const seen = new Set();
      while (cur) {
        if (cur.id === id) return c.json({ ok: false, error: '不能把文件夹移进自己的子文件夹' }, 400);
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        cur = folders.find((f) => f.id === (cur.parentId || null));
      }
    }
    if (folders.some((f) => f.id !== id && (f.parentId || null) === target && f.name === folder.name)) {
      return c.json({ ok: false, error: '目标位置已有同名文件夹' }, 400);
    }
    const updated = await deps.meta.updateFolder(id, { parentId: target });
    log('folder moved:', folder.name, '->', target || 'root');
    return c.json({ ok: true, folder: updated });
  });
}
