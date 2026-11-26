// RelayBox core routes — files (list / search / download / move / rename /
// visibility / expiry / delete). v3.8.0: sub-account subtree sandboxing & permissions.

import { readJsonBody, folderIdOf, folderPath, folderVisibleByCountMap, isExpired, kindOf, safeName, extOf, keyOf, parseExpiresHours, expiresAtOf, parseRange, MIME, R2_FREE_BYTES, log } from '../lib/util.js';
import { originOf, mediaCacheKey, matchEdgeCache, putEdgeCache, purgeEdgeCacheForFile, purgeEdgeCacheForFiles, withCacheHeader, computePublicEdgeTtl } from '../lib/edge-cache.js';
import { getAuthContext, assertFolderInSubtree, auditUserPrefix, authOrPassword, authFail, clientMeta } from '../lib/auth.js';
import { notifyShareConsumed } from '../lib/notify.js';
import { recordAudit } from '../lib/audit.js';
import { getTransferModeState } from './settings.js';
import { hasLocalDisk, buildPoolSummaries, resolveStorageForFile, BUILTIN_R2_ID, BUILTIN_LOCAL_ID } from './pools.js';
import { moveFileToTrash, purgeFilePermanently } from './trash.js';

const MAX_PAGE_LIMIT = 500;
const MAX_BATCH_IDS = 500;

function mapFile(f, shareToken, isAdmin, poolNameMap) {
  const poolId = f.poolId || (f.storage === 'r2' ? BUILTIN_R2_ID : BUILTIN_LOCAL_ID);
  const out = {
    id: f.id, name: f.name, size: f.size, ext: f.ext, kind: f.kind,
    uploadedAt: f.uploadedAt, visibility: f.visibility, storage: f.storage,
    folderId: folderIdOf(f), expiresAt: f.expiresAt || null, downloads: f.downloads || 0,
    poolId: f.poolId || null,
    poolName: (poolNameMap && poolNameMap.get(poolId)) || (f.storage === 'r2' ? '内置 R2' : '本地磁盘'),
    pinned: !!f.pinned,
    note: typeof f.note === 'string' ? f.note : '',
  };
  if (f.width && f.height) {
    out.width = f.width;
    out.height = f.height;
  }
  // 上传者 IP 与归属地严格仅主管理员可见，绝不向未登录访客或子账号暴露。
  if (isAdmin) {
    if (f.uploadIp) out.uploadIp = f.uploadIp;
    if (f.uploadGeo) out.uploadGeo = f.uploadGeo;
  }
  if (shareToken) out.shareToken = shareToken;
  return out;
}

/** Private file access via a share token (file share, or a folder share whose tree holds the file). */
async function canAccessViaShare(deps, item, shareToken) {
  const share = await deps.meta.getShareByToken(shareToken);
  if (!share || isExpired(share)) return false;
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
      if (!s || !s.token || isExpired(s)) continue;
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

/** Slice breadcrumb path so sub-accounts never see ancestor folders above rootFolderId. */
function sliceSubtreePath(folders, targetFolderId, rootFolderId) {
  const full = folderPath(folders, targetFolderId);
  const idx = full.findIndex((x) => x.id === rootFolderId);
  if (idx >= 0) return full.slice(idx);
  const root = folders.find((f) => f.id === rootFolderId);
  return root ? [{ id: root.id, name: root.name }] : [];
}

export function registerFiles(app) {
  // 列表：未登录只看公开文件；子账号锁死在 rootFolderId 子树内；全部由 D1 原生 WHERE + GROUP BY 完成，零全表扫描。
  app.get('/api/files', async (c) => {
    const deps = c.get('deps');
    const requestedFolderId = c.req.query('folderId') || null;
    const rawLimit = Number(c.req.query('limit'));
    const rawOffset = Number(c.req.query('offset'));
    const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.min(MAX_PAGE_LIMIT, Math.floor(rawLimit)) : 0;
    const offset = (Number.isFinite(rawOffset) && rawOffset > 0) ? Math.floor(rawOffset) : 0;
    const rawSort = (c.req.query('sort') || 'time-desc').trim();
    const sort = ['time-desc', 'time-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(rawSort) ? rawSort : 'time-desc';

    const authCtx = await getAuthContext(c, deps);
    const authed = authCtx.authed;
    const isAdmin = authCtx.isAdmin;
    const subUser = authCtx.user;

    let folderId = requestedFolderId;
    if (subUser) {
      if (!folderId) {
        folderId = subUser.rootFolderId;
      } else {
        const ok = await assertFolderInSubtree(deps, folderId, subUser.rootFolderId);
        if (!ok) return c.json({ ok: false, error: '无权访问该目录' }, 403);
      }
    }

    let folders, visible, folderStats, fileCountByFolder, trashStats, poolUsageMap = null;
    const transferPromise = getTransferModeState(deps);
    if (typeof deps.meta.getDirListingBundle === 'function') {
      const [bundle, tr] = await Promise.all([
        deps.meta.getDirListingBundle(folderId, { authed, limit, offset, sort }),
        transferPromise,
      ]);
      ({ folders, files: visible, folderStats, fileCountByFolder, poolUsageMap, trashStats } = bundle);
      var transfer = tr;
    } else {
      const [flds, vis, fStats, fCounts, tr, tStats] = await Promise.all([
        deps.meta.listFolders(),
        deps.meta.listFiles(folderId, { authed, limit, offset, sort }),
        deps.meta.getFolderFileStats(folderId, { authed }),
        deps.meta.getFolderFileCounts({ authed }),
        transferPromise,
        isAdmin ? deps.meta.getTrashStats() : Promise.resolve({ count: 0, totalBytes: 0 }),
      ]);
      folders = flds; visible = vis; folderStats = fStats; fileCountByFolder = fCounts; var transfer = tr; trashStats = tStats;
    }
    const visibleFolders = folders
      .filter((fd) => (fd.parentId || null) === folderId)
      .filter((fd) => authed || folderVisibleByCountMap(folders, fileCountByFolder, fd.id));
    const [poolSummary, shareMaps, userUsedBytes] = await Promise.all([
      buildPoolSummaries(deps, poolUsageMap, { authed: isAdmin, includeAdminMeta: false, transfer }),
      buildShareMaps(deps, visible, visibleFolders, authed),
      (subUser && typeof deps.meta.getUserUsedBytes === 'function')
        ? deps.meta.getUserUsedBytes(subUser.id)
        : Promise.resolve(0),
    ]);
    const files = visible.map((f) => mapFile(f, shareMaps.fileShares.get(f.id) || null, isAdmin, poolSummary.poolNameMap));
    const folderCountByParent = new Map();
    for (const x of folders) {
      const pid = x.parentId || null;
      if (!pid) continue;
      if (authed || folderVisibleByCountMap(folders, fileCountByFolder, x.id)) {
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

    // Sub-account: restrict allFolders to its subtree & slice breadcrumb to rootFolderId.
    let allFoldersList = null;
    let outPath = folderPath(folders, folderId);
    let userPayload = null;
    if (isAdmin) {
      allFoldersList = folders.map((fd) => ({ id: fd.id, name: fd.name, parentId: fd.parentId || null }));
    } else if (subUser) {
      outPath = sliceSubtreePath(folders, folderId, subUser.rootFolderId);
      const folderMap = new Map(folders.map((fd) => [fd.id, fd]));
      allFoldersList = [];
      for (const fd of folders) {
        if (await assertFolderInSubtree(deps, fd.id, subUser.rootFolderId, folderMap)) {
          allFoldersList.push({
            id: fd.id,
            name: fd.name,
            parentId: fd.id === subUser.rootFolderId ? null : (fd.parentId || null),
          });
        }
      }
      const rootFolder = folderMap.get(subUser.rootFolderId);
      userPayload = {
        id: subUser.id,
        username: subUser.username,
        displayName: subUser.displayName || '',
        role: subUser.role === 'guest' ? 'guest' : 'user',
        rootFolderId: subUser.rootFolderId,
        rootFolderName: rootFolder ? rootFolder.name : '',
        quotaBytes: Number(subUser.quotaBytes) > 0 ? Number(subUser.quotaBytes) : 0,
        usedBytes: Number(userUsedBytes) || 0,
        canUpload: !!subUser.canUpload,
        canDelete: !!subUser.canDelete,
        canShare: !!subUser.canShare,
        expiresAt: subUser.expiresAt || null,
      };
    }

    const total = folderStats.totalBytes;
    const r2Used = folderStats.r2Bytes;
    const localUsed = folderStats.localBytes;
    const totalFiles = folderStats.count;
    const hasMore = limit > 0 ? (offset + files.length < totalFiles) : false;
    const chunkSize = deps.config.chunkSize || 5 * 1024 * 1024;
    const presignThreshold = deps.config.chunkUploadThreshold || 32 * 1024 * 1024;
    const proxyThreshold = deps.config.proxyChunkUploadThreshold || Math.min(presignThreshold, chunkSize);
    const effectiveThreshold = transfer.mode === 'proxy' ? proxyThreshold : presignThreshold;
    return c.json({
      ok: true, files, folders: subfolders, path: outPath, folderId, total,
      totalFiles,
      limit: limit || null,
      offset,
      hasMore,
      free: deps.local.freeBytes(), diskTotal: deps.local.totalBytes(),
      hasLocal: hasLocalDisk(deps),
      r2Used, localUsed, r2Total: R2_FREE_BYTES, authed, isAdmin, user: userPayload, r2: deps.r2.enabled,
      r2TransferMode: transfer.mode,
      r2PresignAvailable: transfer.presignAvailable,
      r2ProxyAvailable: transfer.proxyAvailable,
      pools: poolSummary.pools,
      defaultPoolId: poolSummary.defaultPoolId,
      maxUploadSize: deps.config.maxUploadSize || 0,
      chunkUploadThreshold: effectiveThreshold,
      chunkSize,
      ...(isAdmin ? {
        trashCount: trashStats.count,
        trashBytes: trashStats.totalBytes,
        allFolders: allFoldersList,
      } : (subUser ? {
        allFolders: allFoldersList,
      } : {})),
    });
  });

  // 全局搜索：主管理员全站搜；访客只搜公开文件；子账号仅搜 rootFolderId 子树内文件（D1 递归 CTE，零 listAllFiles）。
  app.get('/api/search', async (c) => {
    const deps = c.get('deps');
    const q = (c.req.query('q') || '').trim().toLowerCase();
    if (!q) return c.json({ ok: true, files: [], folders: [], total: 0 });
    const authCtx = await getAuthContext(c, deps);
    const authed = authCtx.authed;
    const isAdmin = authCtx.isAdmin;
    const subUser = authCtx.user;

    let subtreeIds = null;
    let subtreeSet = null;
    if (subUser) {
      if (typeof deps.meta.getFolderSubtreeIds === 'function') {
        subtreeIds = await deps.meta.getFolderSubtreeIds(subUser.rootFolderId);
      } else {
        const allF = await deps.meta.listFolders();
        const fMap = new Map(allF.map((f) => [f.id, f]));
        subtreeIds = [];
        for (const f of allF) {
          if (await assertFolderInSubtree(deps, f.id, subUser.rootFolderId, fMap)) subtreeIds.push(f.id);
        }
      }
      subtreeSet = new Set(subtreeIds);
    }

    const [folders, fileCountByFolder, matched] = await Promise.all([
      deps.meta.listFolders(),
      deps.meta.getFolderFileCounts({ authed }),
      deps.meta.searchFiles(q, { authed, ...(subtreeIds ? { folderIds: subtreeIds } : {}) }),
    ]);
    const matchedRawFolders = folders.filter((fd) => {
      if (!fd.name.toLowerCase().includes(q)) return false;
      if (subUser) return subtreeSet.has(fd.id) && fd.id !== subUser.rootFolderId;
      return authed || folderVisibleByCountMap(folders, fileCountByFolder, fd.id);
    });
    const [poolSummary, shareMaps] = await Promise.all([
      buildPoolSummaries(deps, null, { authed: isAdmin, includeAdminMeta: false }),
      buildShareMaps(deps, matched, matchedRawFolders, authed),
    ]);
    const files = matched.map((f) => {
      const out = mapFile(f, shareMaps.fileShares.get(f.id) || null, isAdmin, poolSummary.poolNameMap);
      const p = subUser ? sliceSubtreePath(folders, folderIdOf(f), subUser.rootFolderId) : folderPath(folders, folderIdOf(f));
      out.folderPath = p.length > 1 ? p.slice(1).map((x) => x.name).join(' / ') : '';
      return out;
    });
    const matchedFolders = matchedRawFolders.map((fd) => {
      const p = subUser ? sliceSubtreePath(folders, fd.parentId || null, subUser.rootFolderId) : folderPath(folders, fd.parentId || null);
      const out = {
        id: fd.id, name: fd.name, parentId: fd.parentId || null, createdAt: fd.createdAt,
        path: p.length > 1 ? p.slice(1).map((x) => x.name).join(' / ') : '',
        fileCount: fileCountByFolder.get(fd.id) || 0,
        folderCount: folders.filter((x) => (x.parentId || null) === fd.id && (authed || folderVisibleByCountMap(folders, fileCountByFolder, x.id))).length,
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
    const range = parseRange(c.req.header('Range'));
    const origin = originOf(c, deps);
    const cacheKey = (!forceDownload && !shareToken && !range && origin) ? mediaCacheKey(origin, id) : null;
    if (cacheKey) {
      const cached = await matchEdgeCache(deps, cacheKey);
      if (cached) {
        const inm = (c.req.header('If-None-Match') || '').trim();
        const cachedEtag = (cached.headers.get('ETag') || '').trim();
        if (inm && cachedEtag && (inm === cachedEtag || inm === `W/${cachedEtag}`)) {
          const h304 = new Headers(cached.headers);
          h304.set('X-RelayBox-Cache', 'HIT');
          return new Response(null, { status: 304, headers: h304 });
        }
        return withCacheHeader(cached, 'HIT');
      }
    }
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (isExpired(item)) return c.json({ ok: false, error: '文件已过期' }, 404);
    if (shareToken) {
      const share = await deps.meta.getShareByToken(shareToken);
      if (share && isExpired(share)) {
        return c.json({ ok: false, error: '分享链接已过期' }, 410);
      }
      if (share && share.code && (shareCode || '') !== share.code) {
        return c.json({ ok: false, error: '提取码不正确' }, 403);
      }
    }
    if (item.visibility === 'private') {
      const authCtx = await getAuthContext(c, deps);
      let allowed = authCtx.isAdmin;
      if (!allowed && authCtx.user) {
        allowed = await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId);
      }
      if (!allowed) {
        const ok = shareToken && (await canAccessViaShare(deps, item, shareToken));
        if (!ok) return c.json({ ok: false, error: '这是私密文件，需要分享链接才能访问' }, 403);
      }
    }
    const mime = MIME[item.ext] || 'application/octet-stream';
    const disposition = (forceDownload ? 'attachment' : 'inline') +
      `; filename*=UTF-8''${encodeURIComponent(item.name)}`;
    const resolved = await resolveStorageForFile(deps, item);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 503);

    const isImmutableMedia = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio';
    const isPrivate = item.visibility !== 'public';
    const edgeTtl = (!isPrivate && !forceDownload && !shareToken)
      ? computePublicEdgeTtl(item.expiresAt, isImmutableMedia ? 31536000 : 86400, 3600)
      : 0;
    const cacheControl = (forceDownload || shareToken)
      ? 'private, no-store'
      : !isPrivate
        ? (!item.expiresAt
          ? (isImmutableMedia ? 'public, max-age=31536000, immutable' : 'public, max-age=86400')
          : (edgeTtl > 0 ? `public, max-age=${edgeTtl}` : 'private, no-store'))
        : isImmutableMedia
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
    const allowPublicRedirect = !isPrivate && !forceDownload && !shareToken;
    try {
      const res = await resolved.driver.get(item.storageKey, {
        mode: resolved.mode,
        start: range ? range.start : undefined,
        end: range ? range.end : undefined,
        contentType: mime,
        disposition,
        cacheControl,
        allowPublicRedirect,
        ...(vary ? { vary } : {}),
        ...(mediaEtag ? { etag: mediaEtag } : {}),
      });
      if (!res) return c.json({ ok: false, error: '文件不存在' }, 404);
      if (forceDownload && res.status !== 416) {
        const incOk = await deps.meta.incrementDownloads(id);
        if (incOk === false) log('warn: failed to increment downloads for', id);
        const consumed = await consumeShare(deps, c, shareToken, item);
        if (!consumed.ok) return c.json({ ok: false, error: '分享下载次数已用完' }, 410);
      }
      let finalRes = res;
      const extLower = (item.ext || '').toLowerCase();
      if (!forceDownload && (extLower === '.html' || extLower === '.htm' || extLower === '.svg' || extLower === '.xml' || extLower === '.xhtml')) {
        const h = new Headers(finalRes.headers);
        h.set('Content-Security-Policy', "default-src 'none'; sandbox");
        finalRes = new Response(finalRes.body, {
          status: finalRes.status,
          statusText: finalRes.statusText,
          headers: h,
        });
      }
      if (cacheKey && finalRes.status === 200 && !isPrivate && edgeTtl > 0) {
        putEdgeCache(deps, c, cacheKey, finalRes);
        return withCacheHeader(finalRes, 'MISS');
      }
      return finalRes;
    } catch (e) {
      log('storage GET failed:', e && e.message);
      return c.json({ ok: false, error: '获取文件失败' }, 500);
    }
  });

  // 上传前全目录判重接口（v3.5.1 + v3.8.0 子账号支持）。
  app.post('/api/files/check-dup', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (authCtx.user) {
      if (!authCtx.user.canUpload) return c.json({ ok: false, error: '当前账号没有上传权限' }, 403);
    } else if (!authCtx.isAdmin) {
      const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
      if (auth !== 'ok') return authFail(c, auth);
    }
    const body = await readJsonBody(c);
    const defaultFolderId = (typeof body.folderId === 'string' && body.folderId)
      ? body.folderId
      : (authCtx.user ? authCtx.user.rootFolderId : null);
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH_IDS) : [];
    const normalized = rawItems
      .filter((x) => x && typeof x.name === 'string' && x.name.trim())
      .map((x, idx) => ({
        idx,
        folderId: (x.folderId !== undefined ? (x.folderId || (authCtx.user ? authCtx.user.rootFolderId : null)) : defaultFolderId),
        name: safeName(x.name),
        size: Math.max(0, Math.floor(Number(x.size) || 0)),
      }));
    if (authCtx.user) {
      const uniqFolders = [...new Set(normalized.map((it) => it.folderId))];
      for (const fid of uniqFolders) {
        if (!(await assertFolderInSubtree(deps, fid, authCtx.user.rootFolderId))) {
          return c.json({ ok: false, error: '无权检测该目录外的重复文件' }, 403);
        }
      }
    }
    if (!normalized.length) return c.json({ ok: true, duplicateIndexes: [] });
    const matched = await deps.meta.findDuplicatesInFolders(normalized);
    const duplicateIndexes = [];
    for (const it of normalized) {
      const k = `${it.folderId || ''}::${it.name}::${it.size}`;
      if (matched.has(k)) duplicateIndexes.push(it.idx);
    }
    return c.json({ ok: true, duplicateIndexes });
  });

  // 批量操作聚合接口（v3.3.10 + v3.8.0 子账号支持）。
  app.post('/api/files/batch', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
    if (!ids.length) return c.json({ ok: false, error: '请至少选择一个文件' }, 400);
    if (ids.length > MAX_BATCH_IDS) return c.json({ ok: false, error: `单次批量操作最多支持 ${MAX_BATCH_IDS} 个文件` }, 400);

    // Sub-account permission & subtree validation
    if (authCtx.user) {
      if (action === 'trash' && !authCtx.user.canDelete) {
        return c.json({ ok: false, error: '当前账号没有删除权限' }, 403);
      }
      if ((action === 'move' || action === 'visibility') && !authCtx.user.canUpload && !authCtx.user.canDelete) {
        return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
      }
      const [items, folders] = await Promise.all([
        deps.meta.getFilesByIds(ids, { includeTrashed: true }),
        deps.meta.listFolders(),
      ]);
      const folderMap = new Map(folders.map((f) => [f.id, f]));
      for (const it of items) {
        if (!(await assertFolderInSubtree(deps, folderIdOf(it), authCtx.user.rootFolderId, folderMap))) {
          return c.json({ ok: false, error: '包含无权操作的目录外文件' }, 403);
        }
      }
    }

    if (action === 'move') {
      let target = (typeof body.folderId === 'string' && body.folderId) ? body.folderId : null;
      if (authCtx.user) {
        if (!target) target = authCtx.user.rootFolderId;
        if (!(await assertFolderInSubtree(deps, target, authCtx.user.rootFolderId))) {
          return c.json({ ok: false, error: '无权移动到目标目录' }, 403);
        }
      }
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
      await purgeEdgeCacheForFiles(deps, c, out.updatedIds);
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
      await purgeEdgeCacheForFiles(deps, c, out.trashedIds);
      if (authCtx.user && out.trashedIds.length) {
        await recordAudit(deps, c, 'file_delete', `${out.trashedIds.length} files`, `${auditUserPrefix(authCtx)}批量移入回收站`);
      }
      log('batch trash:', out.trashedIds.length, 'files');
      return c.json({ ok: true, action, count: out.trashedIds.length, ...out });
    }

    return c.json({ ok: false, error: '不支持的批量操作类型（仅支持 move / visibility / trash）' }, 400);
  });

  // 移动文件到另一个文件夹：子账号需写权限且源与目标均在子树内。
  app.post('/api/files/:id/move', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (authCtx.user && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const { folderId } = await readJsonBody(c);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    let target = (typeof folderId === 'string' && folderId) ? folderId : null;
    if (authCtx.user) {
      if (!target) target = authCtx.user.rootFolderId;
      if (!(await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId)) ||
          !(await assertFolderInSubtree(deps, target, authCtx.user.rootFolderId))) {
        return c.json({ ok: false, error: '无权移动该文件' }, 403);
      }
    }
    if (target && !(await deps.meta.getFolder(target))) return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
    const updated = await deps.meta.updateFile(id, { folderId: target });
    return c.json({ ok: true, file: updated });
  });

  // 文件改名：子账号需写权限且文件在子树内。
  app.post('/api/files/:id/rename', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (authCtx.user && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const { name } = await readJsonBody(c);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (authCtx.user && !(await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权操作该目录外的文件' }, 403);
    }
    const clean = safeName(name);
    if (!clean || clean === 'file') return c.json({ ok: false, error: '文件名不对' }, 400);
    if (clean === item.name) return c.json({ ok: true, file: item });
    if (await deps.meta.hasFileWithName(folderIdOf(item), clean, id)) {
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
    await purgeEdgeCacheForFile(deps, c, id);
    log('renamed:', oldKey, '->', newKey);
    return c.json({ ok: true, file: updated });
  });

  // 切换文件公开/私密：子账号需写权限且文件在子树内。
  app.post('/api/files/:id/visibility', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (authCtx.user && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const { visibility } = await readJsonBody(c);
    if (visibility !== 'public' && visibility !== 'private') {
      return c.json({ ok: false, error: 'visibility 只能是 public 或 private' }, 400);
    }
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (authCtx.user && !(await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权操作该目录外的文件' }, 403);
    }
    const updated = await deps.meta.updateFile(id, { visibility });
    await purgeEdgeCacheForFile(deps, c, id);
    log('visibility:', item.name, '->', visibility);
    return c.json({ ok: true, file: updated });
  });

  // 置顶 / 备注更新（v3.6.0 + v3.8.0 子账号支持）。
  app.post('/api/files/:id/meta', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (authCtx.user && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (authCtx.user && !(await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权操作该目录外的文件' }, 403);
    }
    const patch = {};
    if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
    if (typeof body.note === 'string') patch.note = body.note.trim().slice(0, 200);
    if (!Object.keys(patch).length) return c.json({ ok: true, file: item });
    const updated = await deps.meta.updateFile(id, patch);
    await recordAudit(deps, c, 'file_meta', item.name, `${auditUserPrefix(authCtx)}${Object.keys(patch).join(',')}`);
    return c.json({ ok: true, file: updated });
  });

  // 改已有文件的有效期（只认 0/24/168 三档，0 为永久）。
  app.post('/api/files/:id/expiry', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (!authCtx.authed) return c.json({ ok: false, error: '请先登录' }, 401);
    if (authCtx.user && !authCtx.user.canUpload && !authCtx.user.canDelete) {
      return c.json({ ok: false, error: '当前账号为只读权限' }, 403);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const { expiresHours } = await readJsonBody(c);
    const hours = parseExpiresHours(expiresHours);
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (authCtx.user && !(await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权操作该目录外的文件' }, 403);
    }
    const updated = await deps.meta.updateFile(id, { expiresAt: expiresAtOf(hours) });
    await purgeEdgeCacheForFile(deps, c, id);
    log('expiry:', item.name, '->', hours === 0 ? '永久' : hours + 'h');
    return c.json({ ok: true, file: updated });
  });

  // 删除文件（主管理员、有 canDelete 且在子树内的子账号，或凭上传密码）。
  // 带 ?trash=1 或 { trash: true } 时移入 7 天回收站（软删除）；默认保持直接物理删除兼容既有 API。
  app.delete('/api/files/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);
    const authCtx = await getAuthContext(c, deps);
    if (authCtx.user) {
      if (!authCtx.user.canDelete) {
        return c.json({ ok: false, error: '当前账号没有删除权限' }, 403);
      }
    } else if (!authCtx.isAdmin) {
      const auth = await authOrPassword(c, deps, body.password || '');
      if (auth !== 'ok') return authFail(c, auth);
    }
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (authCtx.user && !(await assertFolderInSubtree(deps, folderIdOf(item), authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权删除该目录外的文件' }, 403);
    }
    const toTrash = (c.req.query('trash') === '1' || body.trash === true) && c.req.query('permanent') !== '1';
    if (toTrash) {
      const res = await moveFileToTrash(deps, item, c);
      if (authCtx.user) {
        await recordAudit(deps, c, 'file_delete', item.name, `${auditUserPrefix(authCtx)}移入回收站`);
      }
      return c.json({
        ok: true,
        trashed: true,
        alreadyTrashed: res.alreadyTrashed,
        file: res.file,
        purgeAt: res.purgeAt,
      });
    }
    await purgeFilePermanently(deps, item, c);
    if (authCtx.user) {
      await recordAudit(deps, c, 'file_delete', item.name, `${auditUserPrefix(authCtx)}彻底删除`);
    }
    log('deleted:', item.name);
    return c.json({ ok: true });
  });
}
