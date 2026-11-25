// RelayBox core routes — 7-day Recycle Bin / Trash (v3.3.6).
// Pure Web APIs, zero Node built-in deps.
// Covers:
//   POST   /api/files/:id/trash    — soft-delete file into recycle bin (admin or upload password)
//   GET    /api/trash              — list trashed files with countdown & folder/pool info (admin)
//   POST   /api/trash/:id/restore  — restore single file (auto fallback to root if folder gone, rename on clash)
//   POST   /api/trash/restore-all  — restore all or selected ids (admin)
//   DELETE /api/trash/:id          — permanently purge single trashed file (admin)
//   POST   /api/trash/empty        — purge all or selected ids (admin)
//   DELETE /api/trash              — alias for empty all (admin)

import { readJsonBody, folderIdOf, folderPath, extOf, safeName, log } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail } from '../lib/auth.js';
import { resolveStorageForFile, buildPoolSummaries, BUILTIN_R2_ID, BUILTIN_LOCAL_ID } from './pools.js';
import { purgeEdgeCacheForFile } from '../lib/edge-cache.js';
import { recordAudit } from '../lib/audit.js';

export const DEFAULT_TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天自动保留

export function trashTtlMsOf(deps) {
  const cfg = Number(deps && deps.config && deps.config.trashTtlMs);
  return (Number.isFinite(cfg) && cfg > 0) ? Math.floor(cfg) : DEFAULT_TRASH_TTL_MS;
}

export function isTrashExpired(item, ttlMs = DEFAULT_TRASH_TTL_MS, now = Date.now()) {
  if (!item || !item.deletedAt) return false;
  const delAt = new Date(item.deletedAt).getTime();
  if (!Number.isFinite(delAt)) return false;
  return (now - delAt) >= ttlMs;
}

/** 物理彻底删除一个文件（存储对象 + 缩略图 + 元数据记录 + 关联分享链接）。 */
export async function purgeFilePermanently(deps, item, c = null) {
  if (!item) return false;
  const resolved = await resolveStorageForFile(deps, item);
  if (resolved.ok) {
    try {
      await resolved.driver.delete(item.storageKey);
    } catch (e) {
      log('storage delete failed:', e && e.message);
    }
  } else {
    log('file removed from meta but storage unavailable:', item.storageKey);
  }
  try { await deps.local.deleteThumb(item.id); } catch {}
  await deps.meta.deleteFile(item.id);
  const share = await deps.meta.getShareByFileId(item.id);
  if (share) await deps.meta.deleteShare(share.token);
  await purgeEdgeCacheForFile(deps, c, item.id);
  return true;
}

/** 软删除一个文件到回收站（保留存储对象与缩略图，吊销已有分享链接防止外泄）。 */
export async function moveFileToTrash(deps, item, c = null) {
  if (!item) return null;
  const ttlMs = trashTtlMsOf(deps);
  if (item.deletedAt) {
    const delMs = new Date(item.deletedAt).getTime();
    return {
      alreadyTrashed: true,
      file: item,
      purgeAt: new Date((Number.isFinite(delMs) ? delMs : Date.now()) + ttlMs).toISOString(),
    };
  }
  const now = Date.now();
  const deletedAt = new Date(now).toISOString();
  const updated = await deps.meta.updateFile(item.id, { deletedAt });
  const share = await deps.meta.getShareByFileId(item.id);
  if (share) await deps.meta.deleteShare(share.token);
  await purgeEdgeCacheForFile(deps, c, item.id);
  log('moved to trash:', item.name, item.id);
  return {
    alreadyTrashed: false,
    file: updated || { ...item, deletedAt },
    purgeAt: new Date(now + ttlMs).toISOString(),
  };
}

/** 若还原目标目录已有同名活动文件，自动生成不重名的逻辑文件名（不动物理 storageKey）。 */
function pickRestoredName(name, activeSiblings) {
  const existing = new Set(activeSiblings.map((f) => f.name));
  if (!existing.has(name)) return { name, renamed: false };
  const ext = extOf(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= 99; i++) {
    const suffix = i === 1 ? ' (还原)' : ` (还原 ${i})`;
    const candidate = safeName(base + suffix + ext);
    if (!existing.has(candidate)) return { name: candidate, renamed: true };
  }
  const fallback = safeName(`${base}_${Date.now().toString(36)}${ext}`);
  return { name: fallback, renamed: true };
}

async function restoreOneTrashedFile(deps, item, folders, activeFiles) {
  const folderSet = new Set(folders.map((fd) => fd.id));
  const origFolderId = folderIdOf(item);
  const restoredToRoot = !!(origFolderId && !folderSet.has(origFolderId));
  const targetFolderId = restoredToRoot ? null : origFolderId;
  const siblings = activeFiles.filter((f) => f.id !== item.id && folderIdOf(f) === targetFolderId);
  const { name: nextName, renamed } = pickRestoredName(item.name, siblings);
  const patch = { deletedAt: null, folderId: targetFolderId };
  if (renamed) patch.name = nextName;
  const updated = await deps.meta.updateFile(item.id, patch);
  const finalItem = updated || { ...item, ...patch };
  activeFiles.push(finalItem);
  log('restored from trash:', finalItem.name, restoredToRoot ? '(fallback root)' : '');
  return { file: finalItem, restoredToRoot, renamed };
}

export function registerTrash(app) {
  // 快捷移入回收站（管理员，或凭上传密码）。
  app.post('/api/files/:id/trash', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    const res = await moveFileToTrash(deps, item, c);
    return c.json({
      ok: true,
      trashed: true,
      alreadyTrashed: res.alreadyTrashed,
      file: res.file,
      purgeAt: res.purgeAt,
    });
  });

  // 列出回收站文件（仅管理员）。
  app.get('/api/trash', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const ttlMs = trashTtlMsOf(deps);
    const now = Date.now();
    const folders = await deps.meta.listFolders();
    const folderIds = new Set(folders.map((fd) => fd.id));
    const [poolSummary, trashed] = await Promise.all([
      buildPoolSummaries(deps, null, { authed: true, includeAdminMeta: false }),
      deps.meta.listTrashedFiles(),
    ]);

    const files = trashed.map((f) => {
      const delMs = new Date(f.deletedAt).getTime();
      const purgeMs = (Number.isFinite(delMs) ? delMs : now) + ttlMs;
      const remainingMs = Math.max(0, purgeMs - now);
      const fid = folderIdOf(f);
      const folderExists = !fid || folderIds.has(fid);
      const p = fid && folderExists ? folderPath(folders, fid) : [];
      const folderName = !fid
        ? '根目录'
        : folderExists
          ? p.slice(1).map((x) => x.name).join(' / ') || '根目录'
          : '原目录已删除';
      const poolId = f.poolId || (f.storage === 'r2' ? BUILTIN_R2_ID : BUILTIN_LOCAL_ID);
      return {
        id: f.id,
        name: f.name,
        size: f.size,
        ext: f.ext,
        kind: f.kind,
        storage: f.storage,
        poolId: f.poolId || null,
        poolName: (poolSummary.poolNameMap && poolSummary.poolNameMap.get(poolId)) || (f.storage === 'r2' ? '内置 R2' : '本地磁盘'),
        folderId: fid,
        folderName,
        folderExists,
        visibility: f.visibility,
        uploadedAt: f.uploadedAt,
        deletedAt: f.deletedAt,
        purgeAt: new Date(purgeMs).toISOString(),
        remainingMs,
        ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
      };
    });

    const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
    return c.json({
      ok: true,
      files,
      total: files.length,
      totalBytes,
      retentionDays: Math.max(1, Math.round(ttlMs / (24 * 3600 * 1000))),
    });
  });

  // 一键还原单个回收站文件（仅管理员）。
  app.post('/api/trash/:id/restore', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (!item.deletedAt) return c.json({ ok: false, error: '该文件不在回收站中' }, 400);
    const folders = await deps.meta.listFolders();
    const folderSet = new Set(folders.map((fd) => fd.id));
    const origFolderId = folderIdOf(item);
    const targetFolderId = (origFolderId && !folderSet.has(origFolderId)) ? null : origFolderId;
    const activeFiles = await deps.meta.listFilesInFolders([targetFolderId]);
    const res = await restoreOneTrashedFile(deps, item, folders, activeFiles);
    return c.json({ ok: true, ...res });
  });

  // 批量 / 全部还原回收站文件（仅管理员）。
  app.post('/api/trash/restore-all', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const filterIds = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids.map(String)) : null;
    const [trashed, folders] = await Promise.all([
      deps.meta.listTrashedFiles(),
      deps.meta.listFolders(),
    ]);
    const targets = filterIds ? trashed.filter((f) => filterIds.has(f.id)) : trashed;
    const folderSet = new Set(folders.map((fd) => fd.id));
    const targetFolderIds = [...new Set(targets.map((it) => {
      const orig = folderIdOf(it);
      return (orig && !folderSet.has(orig)) ? null : orig;
    }))];
    const activeFiles = targetFolderIds.length ? await deps.meta.listFilesInFolders(targetFolderIds) : [];
    let restored = 0;
    let restoredToRoot = 0;
    for (const item of targets) {
      const r = await restoreOneTrashedFile(deps, item, folders, activeFiles);
      restored++;
      if (r.restoredToRoot) restoredToRoot++;
    }
    return c.json({ ok: true, restored, restoredToRoot });
  });

  // 从回收站彻底删除单个文件（仅管理员）。
  app.delete('/api/trash/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const item = await deps.meta.getFile(id);
    if (!item || !item.deletedAt) return c.json({ ok: false, error: '回收站中找不到该文件' }, 404);
    await purgeFilePermanently(deps, item, c);
    await recordAudit(deps, c, 'trash_purge', item.name, `彻底删除 (${item.size || 0} B)`);
    log('purged from trash:', item.name);
    return c.json({ ok: true, purged: 1, freedBytes: item.size || 0 });
  });

  // 一键清空回收站（或按 ids 批量彻底删除，仅管理员）。
  async function handleEmptyTrash(c) {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const filterIds = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids.map(String)) : null;
    const trashed = await deps.meta.listTrashedFiles();
    const targets = filterIds ? trashed.filter((f) => filterIds.has(f.id)) : trashed;
    let purged = 0;
    let freedBytes = 0;
    for (const item of targets) {
      await purgeFilePermanently(deps, item, c);
      purged++;
      freedBytes += (item.size || 0);
    }
    if (purged > 0) await recordAudit(deps, c, 'trash_empty', `${purged} 个文件`, `释放 ${freedBytes} B`);
    log('trash emptied:', purged, 'files,', freedBytes + 'B');
    return c.json({ ok: true, purged, freedBytes });
  }
  app.post('/api/trash/empty', handleEmptyTrash);
  app.delete('/api/trash', handleEmptyTrash);
}
