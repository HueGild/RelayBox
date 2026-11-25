// RelayBox core routes — files (list / search / download / move / rename /
// visibility / expiry / delete). Supports v3.1.5 file details, v3.1.6 dual mode,
// and v3.2 multi-storage pools.

import { readJsonBody, folderIdOf, folderPath, folderVisibleToGuest, isExpired, kindOf, safeName, extOf, keyOf, parseExpiresHours, expiresAtOf, parseRange, MIME, R2_FREE_BYTES, log } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail, clientMeta } from '../lib/auth.js';
import { notifyShareConsumed } from '../lib/notify.js';
import { getTransferModeState } from './settings.js';
import { hasLocalDisk, buildPoolSummaries, resolveStorageForFile, BUILTIN_R2_ID, BUILTIN_LOCAL_ID } from './pools.js';
import { moveFileToTrash, purgeFilePermanently } from './trash.js';

function mapFile(f, shareToken, authed, poolNameMap) {
  const poolId = f.poolId || (f.storage === 'r2' ? BUILTIN_R2_ID : BUILTIN_LOCAL_ID);
  const out = {
    id: f.id, name: f.name, size: f.size, ext: f.ext, kind: f.kind,
    uploadedAt: f.uploadedAt, visibility: f.visibility, storage: f.storage,
    folderId: folderIdOf(f), expiresAt: f.expiresAt || null, downloads: f.downloads || 0,
    poolId: f.poolId || null,
    poolName: (poolNameMap && poolNameMap.get(poolId)) || (f.storage === 'r2' ? '内置 R2' : '本地磁盘'),
  };
  if (f.width && f.height) {
    out.width = f.width;
    out.height = f.height;
  }
  // 上传者 IP 与归属地严格仅管理员可见，绝不向未登录访客暴露。
  if (authed) {
    if (f.uploadIp) out.uploadIp = f.uploadIp;
    if (f.uploadGeo) out.uploadGeo = f.uploadGeo;
  }
  if (shareToken) out.shareToken = shareToken;
  return out;
}

/** Private file access via a share token (file share, or a folder share whose tree holds the file). */
async function canAccessViaShare(deps, item, shareToken) {
  const share = await deps.meta.getShareByToken(shareToken);
  if (!share) return false;
  if (share.fileId === item.id) return true;
  if (share.folderId) {
    const folders = await deps.meta.listFolders();
    let cur = folderIdOf(item);
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (cur === share.folderId) return true;
      seen.add(cur);
      const fd = folders.find((x) => x.id === cur);
      cur = fd ? (fd.parentId || null) : null;
    }
  }
  return false;
}

async function consumeShare(deps, c, token, item) {
  if (!token) return { ok: true };
  const changes = await deps.meta.incrementShareDownloads(token);
  if (changes === 0) return { ok: false, exhausted: true };
  const share = await deps.meta.getShareByToken(token);
  if (!share) return { ok: true };
  const burned = !!share.burn;
  const reachedMax = !burned && share.maxDownloads > 0 && share.usedDownloads >= share.maxDownloads;
  if (burned) {
    await deps.meta.deleteShare(token);
    log('share consumed after download:', token);
  }
  if (burned || reachedMax) {
    let targetName = (item && item.name) || token;
    const isFolder = !!share.folderId;
    if (isFolder) {
      try {
        const fd = await deps.meta.getFolder(share.folderId);
        if (fd && fd.name) targetName = item && item.name ? `${fd.name} / ${item.name}` : fd.name;
      } catch {}
    }
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    notifyShareConsumed(deps, c, {
      targetName,
      isFolder,
      token,
      burn: burned,
      usedDownloads: share.usedDownloads,
      maxDownloads: share.maxDownloads,
      ip: uploadIp,
      geo: uploadGeo,
    });
  }
  return { ok: true };
}

/** 一次性批量加载分享映射（消除列表与搜索的 N+1 查库；若自定义 MetaStore 未实现 listShares 则自动降级）。 */
async function buildShareMaps(deps, visibleFiles, visibleFolders, authed) {
  const fileShares = new Map();
  const folderShares = new Map();
  if (!authed) return { fileShares, folderShares };
  if (typeof deps.meta.listShares === 'function') {
    const shares = await deps.meta.listShares();
    for (const s of (shares || [])) {
      if (!s || !s.token) continue;
      if (s.fileId && !fileShares.has(s.fileId)) fileShares.set(s.fileId, s.token);
      if (s.folderId && !folderShares.has(s.folderId)) folderShares.set(s.folderId, s.token);
    }
    return { fileShares, folderShares };
  }
  await Promise.all([
    ...(visibleFiles || []).map(async (f) => {
      const s = await deps.meta.getShareByFileId(f.id);
      if (s && s.token) fileShares.set(f.id, s.token);
    }),
    ...(visibleFolders || []).map(async (fd) => {
      const s = await deps.meta.getShareByFolderId(fd.id);
      if (s && s.token) folderShares.set(fd.id, s.token);
    }),
  ]);
  return { fileShares, folderShares };
}

export function registerFiles(app) {
  // 列表：未登录只看公开文件；管理员看全部，且能看到分享 token、上传 IP/归属地、各存储池用量与轻量目录树。
  app.get('/api/files', async (c) => {
    const deps = c.get('deps');
    const folderId = c.req.query('folderId') || null;
    const [authed, folders, allFilesWithTrash, transfer] = await Promise.all([
      isAuthed(c, deps),
      deps.meta.listFolders(),
      deps.meta.listAllFiles({ authed: true, includeTrashed: true }),
      getTransferModeState(deps),
    ]);
    const allFiles = allFilesWithTrash.filter((f) => !f.deletedAt);
    const trashedFiles = allFilesWithTrash.filter((f) => !!f.deletedAt);
    const filesForCounts = allFiles.filter((f) => !isExpired(f) && (authed || f.visibility === 'public'));
    const visible = filesForCounts.filter((f) => folderIdOf(f) === folderId);
    const visibleFolders = folders
      .filter((fd) => (fd.parentId || null) === folderId)
      .filter((fd) => authed || folderVisibleToGuest(folders, allFiles, fd.id));
    const [poolSummary, shareMaps] = await Promise.all([
      buildPoolSummaries(deps, allFilesWithTrash, { authed, includeAdminMeta: false, transfer }),
      buildShareMaps(deps, visible, visibleFolders, authed),
    ]);
    const files = visible.map((f) => mapFile(f, shareMaps.fileShares.get(f.id) || null, authed, poolSummary.poolNameMap));
    const fileCountByFolder = new Map();
    for (const f of filesForCounts) {
      const fid = folderIdOf(f);
      if (fid) fileCountByFolder.set(fid, (fileCountByFolder.get(fid) || 0) + 1);
    }
    const folderCountByParent = new Map();
    for (const x of folders) {
      const pid = x.parentId || null;
      if (!pid) continue;
      if (authed || folderVisibleToGuest(folders, allFiles, x.id)) {
        folderCountByParent.set(pid, (folderCountByParent.get(pid) || 0) + 1);
      }
    }
    const subfolders = visibleFolders.map((fd) => {
      const out = {
        id: fd.id, name: fd.name, parentId: fd.parentId || null, createdAt: fd.createdAt,
        fileCount: fileCountByFolder.get(fd.id) || 0,
        folderCount: folderCountByParent.get(fd.id) || 0,
      };
      const st = shareMaps.folderShares.get(fd.id);
      if (st) out.shareToken = st;
      return out;
    });
    const total = files.reduce((a, f) => a + f.size, 0);
    const r2Used = files.filter((f) => f.storage === 'r2').reduce((a, f) => a + f.size, 0);
    const localUsed = files.filter((f) => f.storage !== 'r2').reduce((a, f) => a + f.size, 0);
    const chunkSize = deps.config.chunkSize || 5 * 1024 * 1024;
    const presignThreshold = deps.config.chunkUploadThreshold || 32 * 1024 * 1024;
    const proxyThreshold = deps.config.proxyChunkUploadThreshold || Math.min(presignThreshold, chunkSize);
    const effectiveThreshold = transfer.mode === 'proxy' ? proxyThreshold : presignThreshold;
    return c.json({
      ok: true, files, folders: subfolders, path: folderPath(folders, folderId), folderId, total,
      free: deps.local.freeBytes(), diskTotal: deps.local.totalBytes(),
      hasLocal: hasLocalDisk(deps),
      r2Used, localUsed, r2Total: R2_FREE_BYTES, authed, r2: deps.r2.enabled,
      r2TransferMode: transfer.mode,
      r2PresignAvailable: transfer.presignAvailable,
      r2ProxyAvailable: transfer.proxyAvailable,
      pools: poolSummary.pools,
      defaultPoolId: poolSummary.defaultPoolId,
      maxUploadSize: deps.config.maxUploadSize || 0,
      chunkUploadThreshold: effectiveThreshold,
      chunkSize,
      ...(authed ? {
        trashCount: trashedFiles.length,
        trashBytes: trashedFiles.reduce((a, f) => a + (f.size || 0), 0),
        allFolders: folders.map((fd) => ({ id: fd.id, name: fd.name, parentId: fd.parentId || null })),
      } : {}),
    });
  });

  // 全局搜索：跨所有文件夹按文件名搜（不区分大小写）；访客只搜得到公开文件。
  app.get('/api/search', async (c) => {
    const deps = c.get('deps');
    const q = (c.req.query('q') || '').trim().toLowerCase();
    if (!q) return c.json({ ok: true, files: [], folders: [], total: 0 });
    const [authed, folders, allFiles] = await Promise.all([
      isAuthed(c, deps),
      deps.meta.listFolders(),
      deps.meta.listAllFiles({ authed: true }),
    ]);
    const matched = await deps.meta.searchFiles(q, { authed });
    const matchedRawFolders = folders.filter((fd) => (
      fd.name.toLowerCase().includes(q) && (authed || folderVisibleToGuest(folders, allFiles, fd.id))
    ));
    const [poolSummary, shareMaps] = await Promise.all([
      buildPoolSummaries(deps, allFiles, { authed, includeAdminMeta: false }),
      buildShareMaps(deps, matched, matchedRawFolders, authed),
    ]);
    const files = matched.map((f) => {
      const out = mapFile(f, shareMaps.fileShares.get(f.id) || null, authed, poolSummary.poolNameMap);
      const p = folderPath(folders, folderIdOf(f));
      out.folderPath = p.length > 1 ? p.slice(1).map((x) => x.name).join(' / ') : '';
      return out;
    });
    const matchedFolders = matchedRawFolders.map((fd) => {
      const p = folderPath(folders, fd.parentId || null);
      const out = {
        id: fd.id, name: fd.name, parentId: fd.parentId || null, createdAt: fd.createdAt,
        path: p.length > 1 ? p.slice(1).map((x) => x.name).join(' / ') : '',
        fileCount: allFiles.filter((f) => !isExpired(f) && (authed || f.visibility === 'public') && folderIdOf(f) === fd.id).length,
        folderCount: folders.filter((x) => (x.parentId || null) === fd.id && (authed || folderVisibleToGuest(folders, allFiles, x.id))).length,
      };
      const st = shareMaps.folderShares.get(fd.id);
      if (st) out.shareToken = st;
      return out;
    });
    return c.json({ ok: true, files, folders: matchedFolders, total: files.length + matchedFolders.length });
  });

  // 下载/在线看：支持 Range（视频拖进度条必需）。自动按文件所属存储池路由。
  app.get('/f/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const forceDownload = c.req.query('download') === '1';
    const shareToken = c.req.query('share') || '';
    const shareCode = c.req.query('code') || '';
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (isExpired(item)) return c.json({ ok: false, error: '文件已过期' }, 404);
    if (shareToken) {
      const share = await deps.meta.getShareByToken(shareToken);
      if (share && share.code && (shareCode || '') !== share.code) {
        return c.json({ ok: false, error: '提取码不正确' }, 403);
      }
    }
    if (item.visibility === 'private' && !(await isAuthed(c, deps))) {
      const ok = shareToken && (await canAccessViaShare(deps, item, shareToken));
      if (!ok) return c.json({ ok: false, error: '这是私密文件，需要分享链接才能访问' }, 403);
    }
    if (forceDownload) await deps.meta.incrementDownloads(id);
    const mime = MIME[item.ext] || 'application/octet-stream';
    const disposition = (forceDownload ? 'attachment' : 'inline') +
      `; filename*=UTF-8''${encodeURIComponent(item.name)}`;
    const range = parseRange(c.req.header('Range'));
    const resolved = await resolveStorageForFile(deps, item);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 503);

    const isImmutableMedia = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio';
    const isPrivate = item.visibility !== 'public';
    const cacheControl = (forceDownload || shareToken)
      ? 'private, no-store'
      : (!isPrivate && !item.expiresAt)
        ? (isImmutableMedia ? 'public, max-age=31536000, immutable' : 'public, max-age=86400')
        : (isPrivate && isImmutableMedia)
          ? 'private, max-age=3600'
          : 'private, no-store';
    const vary = (isPrivate && !forceDownload && !shareToken) ? 'Cookie' : '';
    const mediaEtag = (isImmutableMedia && !forceDownload && !shareToken) ? `"f-${item.id}-${item.size}"` : '';
    if (mediaEtag && !range && (resolved.mode === 'proxy' || resolved.mode === 'local')) {
      const inm = (c.req.header('If-None-Match') || '').trim();
      if (inm && (inm === mediaEtag || inm === `W/${mediaEtag}`)) {
        const h304 = { 'Cache-Control': cacheControl, 'ETag': mediaEtag };
        if (vary) h304['Vary'] = vary;
        return new Response(null, { status: 304, headers: h304 });
      }
    }
    try {
      const res = await resolved.driver.get(item.storageKey, {
        mode: resolved.mode,
        start: range ? range.start : undefined,
        end: range ? range.end : undefined,
        contentType: mime,
        disposition,
        cacheControl,
        ...(vary ? { vary } : {}),
        ...(mediaEtag ? { etag: mediaEtag } : {}),
      });
      if (!res) return c.json({ ok: false, error: '文件不存在' }, 404);
      if (forceDownload && res.status !== 416) {
        const consumed = await consumeShare(deps, c, shareToken, item);
        if (!consumed.ok) return c.json({ ok: false, error: '分享下载次数已用完' }, 410);
      }
      return res;
    } catch (e) {
      log('storage GET failed:', e && e.message);
      return c.json({ ok: false, error: '获取文件失败' }, 500);
    }
  });

  // 批量操作聚合接口（管理员，v3.3.10）：一次请求完成 move / visibility / trash，消除串行请求与 VPS JSON 写放大。
  app.post('/api/files/batch', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
    if (!ids.length) return c.json({ ok: false, error: '请至少选择一个文件' }, 400);
    if (ids.length > 500) return c.json({ ok: false, error: '单次批量操作最多支持 500 个文件' }, 400);

    if (action === 'move') {
      const target = (typeof body.folderId === 'string' && body.folderId) ? body.folderId : null;
      if (target && !(await deps.meta.getFolder(target))) {
        return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
      }
      let out;
      if (typeof deps.meta.batchUpdateFiles === 'function') {
        out = await deps.meta.batchUpdateFiles(ids, { folderId: target });
      } else {
        const updatedIds = [];
        const notFoundIds = [];
        for (const id of ids) {
          const item = await deps.meta.getFile(id);
          if (!item || item.deletedAt) { notFoundIds.push(id); continue; }
          await deps.meta.updateFile(id, { folderId: target });
          updatedIds.push(id);
        }
        out = { updatedIds, notFoundIds };
      }
      log('batch move:', out.updatedIds.length, 'files ->', target || 'root');
      return c.json({ ok: true, action, count: out.updatedIds.length, ...out });
    }

    if (action === 'visibility') {
      const visibility = body.visibility;
      if (visibility !== 'public' && visibility !== 'private') {
        return c.json({ ok: false, error: 'visibility 只能是 public 或 private' }, 400);
      }
      let out;
      if (typeof deps.meta.batchUpdateFiles === 'function') {
        out = await deps.meta.batchUpdateFiles(ids, { visibility });
      } else {
        const updatedIds = [];
        const notFoundIds = [];
        for (const id of ids) {
          const item = await deps.meta.getFile(id);
          if (!item || item.deletedAt) { notFoundIds.push(id); continue; }
          await deps.meta.updateFile(id, { visibility });
          updatedIds.push(id);
        }
        out = { updatedIds, notFoundIds };
      }
      log('batch visibility:', out.updatedIds.length, 'files ->', visibility);
      return c.json({ ok: true, action, count: out.updatedIds.length, ...out });
    }

    if (action === 'trash') {
      const deletedAt = new Date().toISOString();
      let out;
      if (typeof deps.meta.batchTrashFiles === 'function') {
        out = await deps.meta.batchTrashFiles(ids, deletedAt);
      } else {
        const trashedIds = [];
        const alreadyTrashedIds = [];
        const notFoundIds = [];
        for (const id of ids) {
          const item = await deps.meta.getFile(id);
          if (!item) { notFoundIds.push(id); continue; }
          const res = await moveFileToTrash(deps, item);
          if (res && res.alreadyTrashed) alreadyTrashedIds.push(id);
          else trashedIds.push(id);
        }
        out = { trashedIds, alreadyTrashedIds, notFoundIds };
      }
      log('batch trash:', out.trashedIds.length, 'files');
      return c.json({ ok: true, action, count: out.trashedIds.length, ...out });
    }

    return c.json({ ok: false, error: '不支持的批量操作类型（仅支持 move / visibility / trash）' }, 400);
  });

  // 移动文件到另一个文件夹（管理员）。folderId 为空表示移回根目录。
  app.post('/api/files/:id/move', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { folderId } = await readJsonBody(c);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    const target = (typeof folderId === 'string' && folderId) ? folderId : null;
    if (target && !(await deps.meta.getFolder(target))) return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
    const updated = await deps.meta.updateFile(id, { folderId: target });
    return c.json({ ok: true, file: updated });
  });

  // 文件改名（管理员）。
  app.post('/api/files/:id/rename', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { name } = await readJsonBody(c);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    const clean = safeName(name);
    if (!clean || clean === 'file') return c.json({ ok: false, error: '文件名不对' }, 400);
    if (clean === item.name) return c.json({ ok: true, file: item });
    const siblings = await deps.meta.listAllFiles({ authed: true });
    if (siblings.some((f) => f.id !== id && folderIdOf(f) === folderIdOf(item) && f.name === clean)) {
      return c.json({ ok: false, error: '同文件夹已有同名文件' }, 400);
    }
    const oldKey = item.storageKey;
    const newKey = keyOf(item.id, clean);
    const resolved = await resolveStorageForFile(deps, item);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status === 503 ? 501 : (resolved.status || 500));
    try {
      await resolved.driver.rename(oldKey, newKey);
    } catch (e) {
      log('rename failed:', e && e.message);
      return c.json({ ok: false, error: '改名失败' }, 500);
    }
    const updated = await deps.meta.updateFile(id, {
      name: clean, ext: extOf(clean), kind: kindOf(extOf(clean)), storageKey: newKey,
    });
    log('renamed:', oldKey, '->', newKey);
    return c.json({ ok: true, file: updated });
  });

  // 切换文件公开/私密（管理员）。
  app.post('/api/files/:id/visibility', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { visibility } = await readJsonBody(c);
    if (visibility !== 'public' && visibility !== 'private') {
      return c.json({ ok: false, error: 'visibility 只能是 public 或 private' }, 400);
    }
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    const updated = await deps.meta.updateFile(id, { visibility });
    log('visibility:', item.name, '->', visibility);
    return c.json({ ok: true, file: updated });
  });

  // 改已有文件的有效期（只认 0/24/168 三档，0 为永久）。
  app.post('/api/files/:id/expiry', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { expiresHours } = await readJsonBody(c);
    const hours = parseExpiresHours(expiresHours);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    const updated = await deps.meta.updateFile(id, { expiresAt: expiresAtOf(hours) });
    log('expiry:', item.name, '->', hours === 0 ? '永久' : hours + 'h');
    return c.json({ ok: true, file: updated });
  });

  // 删除文件（管理员，或凭上传密码）。
  // 带 ?trash=1 或 { trash: true } 时移入 7 天回收站（软删除）；默认保持直接物理删除兼容既有 API。
  app.delete('/api/files/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    const toTrash = (c.req.query('trash') === '1' || body.trash === true) && c.req.query('permanent') !== '1';
    if (toTrash) {
      const res = await moveFileToTrash(deps, item);
      return c.json({
        ok: true,
        trashed: true,
        alreadyTrashed: res.alreadyTrashed,
        file: res.file,
        purgeAt: res.purgeAt,
      });
    }
    await purgeFilePermanently(deps, item);
    log('deleted:', item.name);
    return c.json({ ok: true });
  });
}

