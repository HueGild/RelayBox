// RelayBox core routes — folders (list / create / delete / rename / move).
// Mirrors v2.8.4's handleCreateFolder / handleDeleteFolder / handleRenameFolder /
// handleMoveFolder exactly.

import { readJsonBody, folderIdOf, safeName, newId, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';

export function registerFolders(app) {
  // 全部文件夹（管理员）。
  app.get('/api/folders', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    return c.json({ ok: true, folders: await deps.meta.listFolders() });
  });

  // 新建文件夹（管理员）。parentId 为空表示根目录；同级不许重名。
  app.post('/api/folders', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const { name, parentId } = await readJsonBody(c);
    const folders = await deps.meta.listFolders();
    const pid = (typeof parentId === 'string' && parentId) ? parentId : null;
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

  // 删除文件夹（管理员）：仅空文件夹能删，非空先报错，让管理员先移走或删掉里面的东西。
  app.delete('/api/folders/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const folders = await deps.meta.listFolders();
    const folder = folders.find((f) => f.id === id);
    if (!folder) return c.json({ ok: false, error: '文件夹不存在' }, 404);
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

  // 文件夹改名（管理员）。
  app.post('/api/folders/:id/rename', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { name } = await readJsonBody(c);
    const folders = await deps.meta.listFolders();
    const folder = folders.find((f) => f.id === id);
    if (!folder) return c.json({ ok: false, error: '文件夹不存在' }, 404);
    const clean = safeName(name);
    if (!clean || clean === 'file') return c.json({ ok: false, error: '文件夹名字不对' }, 400);
    if (folders.some((f) => f.id !== id && (f.parentId || null) === (folder.parentId || null) && f.name === clean)) {
      return c.json({ ok: false, error: '同级已有同名文件夹' }, 400);
    }
    const updated = await deps.meta.updateFolder(id, { name: clean });
    return c.json({ ok: true, folder: updated });
  });

  // 移动文件夹（管理员）：parentId 为空表示移回根目录。不能移进自己或自己的子孙文件夹；同级重名拒绝。
  app.post('/api/folders/:id/move', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { parentId } = await readJsonBody(c);
    const target = parentId || null;
    const folders = await deps.meta.listFolders();
    const folder = folders.find((f) => f.id === id);
    if (!folder) return c.json({ ok: false, error: '文件夹不存在' }, 404);
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
