// RelayBox core routes — files (list / search / download / move / rename /
// visibility / expiry / delete). Mirrors v2.8.4's router + handlers + v3.1.5 file details.

import { readJsonBody, folderIdOf, folderPath, folderVisibleToGuest, isExpired, kindOf, safeName, extOf, keyOf, parseExpiresHours, expiresAtOf, parseRange, MIME, R2_FREE_BYTES, log } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail } from '../lib/auth.js';

function mapFile(f, shareToken, authed) {
  const out = {
    id: f.id, name: f.name, size: f.size, ext: f.ext, kind: f.kind,
    uploadedAt: f.uploadedAt, visibility: f.visibility, storage: f.storage,
    folderId: folderIdOf(f), expiresAt: f.expiresAt || null, downloads: f.downloads || 0,
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

async function consumeShare(deps, token) {
  if (!token) return { ok: true };
  const changes = await deps.meta.incrementShareDownloads(token);
  if (changes === 0) return { ok: false, exhausted: true };
  const share = await deps.meta.getShareByToken(token);
  if (share && share.burn) {
    await deps.meta.deleteShare(token);
    log('share consumed after download:', token);
  }
  return { ok: true };
}

export function registerFiles(app) {
  // 列表：未登录只看公开文件；管理员看全部，且能看到分享 token 及上传 IP/归属地。
  app.get('/api/files', async (c) => {
    const deps = c.get('deps');
    const authed = await isAuthed(c, deps);
    const folders = await deps.meta.listFolders();
    const folderId = c.req.query('folderId') || null;
    const visible = await deps.meta.listFiles(folderId, { authed });
    const files = [];
    for (const f of visible) {
      const s = authed ? await deps.meta.getShareByFileId(f.id) : null;
      files.push(mapFile(f, s ? s.token : null, authed));
    }
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const filesForCounts = allFiles.filter((f) => !isExpired(f) && (authed || f.visibility === 'public'));
    const visibleFolders = folders
      .filter((fd) => (fd.parentId || null) === folderId)
      .filter((fd) => authed || folderVisibleToGuest(folders, allFiles, fd.id));
    const subfolders = [];
    for (const fd of visibleFolders) {
      const out = {
        id: fd.id, name: fd.name, parentId: fd.parentId || null, createdAt: fd.createdAt,
        fileCount: filesForCounts.filter((f) => folderIdOf(f) === fd.id).length,
        folderCount: folders.filter((x) => (x.parentId || null) === fd.id && (authed || folderVisibleToGuest(folders, allFiles, x.id))).length,
      };
      if (authed) {
        const s = await deps.meta.getShareByFolderId(fd.id);
        if (s) out.shareToken = s.token;
      }
      subfolders.push(out);
    }
    const total = files.reduce((a, f) => a + f.size, 0);
    const r2Used = files.filter((f) => f.storage === 'r2').reduce((a, f) => a + f.size, 0);
    const localUsed = files.filter((f) => f.storage !== 'r2').reduce((a, f) => a + f.size, 0);
    return c.json({
      ok: true, files, folders: subfolders, path: folderPath(folders, folderId), folderId, total,
      free: deps.local.freeBytes(), diskTotal: deps.local.totalBytes(),
      r2Used, localUsed, r2Total: R2_FREE_BYTES, authed, r2: deps.r2.enabled,
      chunkUploadThreshold: deps.config.chunkUploadThreshold || 32 * 1024 * 1024,
      chunkSize: deps.config.chunkSize || 5 * 1024 * 1024,
    });
  });

  // 全局搜索：跨所有文件夹按文件名搜（不区分大小写）；访客只搜得到公开文件。
  app.get('/api/search', async (c) => {
    const deps = c.get('deps');
    const authed = await isAuthed(c, deps);
    const q = (c.req.query('q') || '').trim().toLowerCase();
    if (!q) return c.json({ ok: true, files: [], folders: [], total: 0 });
    const folders = await deps.meta.listFolders();
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const matched = await deps.meta.searchFiles(q, { authed });
    const files = [];
    for (const f of matched) {
      const s = authed ? await deps.meta.getShareByFileId(f.id) : null;
      const out = mapFile(f, s ? s.token : null, authed);
      const p = folderPath(folders, folderIdOf(f));
      out.folderPath = p.length > 1 ? p.slice(1).map((x) => x.name).join(' / ') : '';
      files.push(out);
    }
    const matchedFolders = [];
    for (const fd of folders) {
      if (!fd.name.toLowerCase().includes(q)) continue;
      if (!(authed || folderVisibleToGuest(folders, allFiles, fd.id))) continue;
      const p = folderPath(folders, fd.parentId || null);
      const out = {
        id: fd.id, name: fd.name, parentId: fd.parentId || null, createdAt: fd.createdAt,
        path: p.length > 1 ? p.slice(1).map((x) => x.name).join(' / ') : '',
        fileCount: allFiles.filter((f) => !isExpired(f) && (authed || f.visibility === 'public') && folderIdOf(f) === fd.id).length,
        folderCount: folders.filter((x) => (x.parentId || null) === fd.id && (authed || folderVisibleToGuest(folders, allFiles, x.id))).length,
      };
      if (authed) {
        const s = await deps.meta.getShareByFolderId(fd.id);
        if (s) out.shareToken = s.token;
      }
      matchedFolders.push(out);
    }
    return c.json({ ok: true, files, folders: matchedFolders, total: files.length + matchedFolders.length });
  });

  // 下载/在线看：支持 Range（视频拖进度条必需）。?download=1 时强制下载并计数。
  app.get('/f/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const forceDownload = c.req.query('download') === '1';
    const shareToken = c.req.query('share') || '';
    const shareCode = c.req.query('code') || '';
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
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
    if (item.storage === 'r2') {
      if (!deps.r2.enabled) return c.json({ ok: false, error: 'R2 未配置，文件暂时无法访问' }, 503);
      try {
        const res = await deps.r2.get(item.storageKey, { contentType: mime, disposition });
        if (forceDownload) {
          const consumed = await consumeShare(deps, shareToken);
          if (!consumed.ok) return c.json({ ok: false, error: '分享下载次数已用完' }, 410);
        }
        return res;
      } catch (e) {
        log('presign GET failed:', e && e.message);
        return c.json({ ok: false, error: '生成下载链接失败' }, 500);
      }
    }
    const res = await deps.local.get(item.storageKey, {
      start: range ? range.start : undefined,
      end: range ? range.end : undefined,
      contentType: mime, disposition,
    });
    if (!res) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (forceDownload && res.status !== 416) {
      const consumed = await consumeShare(deps, shareToken);
      if (!consumed.ok) return c.json({ ok: false, error: '分享下载次数已用完' }, 410);
    }
    return res;
  });

  // 移动文件到另一个文件夹（管理员）。folderId 为空表示移回根目录。
  app.post('/api/files/:id/move', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const { folderId } = await readJsonBody(c);
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
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
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    const clean = safeName(name);
    if (!clean || clean === 'file') return c.json({ ok: false, error: '文件名不对' }, 400);
    if (clean === item.name) return c.json({ ok: true, file: item });
    const siblings = await deps.meta.listAllFiles({ authed: true });
    if (siblings.some((f) => f.id !== id && folderIdOf(f) === folderIdOf(item) && f.name === clean)) {
      return c.json({ ok: false, error: '同文件夹已有同名文件' }, 400);
    }
    const oldKey = item.storageKey;
    const newKey = keyOf(item.id, clean);
    if (item.storage === 'r2') {
      if (!deps.r2.enabled) return c.json({ ok: false, error: 'R2 未配置，无法改名' }, 501);
      try {
        await deps.r2.rename(oldKey, newKey);
      } catch (e) {
        log('R2 rename failed:', e && e.message);
        return c.json({ ok: false, error: '改名失败' }, 500);
      }
    } else {
      try {
        await deps.local.rename(oldKey, newKey);
      } catch (e) {
        log('local rename failed:', e && e.message);
        return c.json({ ok: false, error: '改名失败' }, 500);
      }
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
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
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
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    const updated = await deps.meta.updateFile(id, { expiresAt: expiresAtOf(hours) });
    log('expiry:', item.name, '->', hours === 0 ? '永久' : hours + 'h');
    return c.json({ ok: true, file: updated });
  });

  // 删除文件（管理员，或凭上传密码）。
  app.delete('/api/files/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (item.storage === 'r2') {
      if (deps.r2.enabled) {
        try { await deps.r2.delete(item.storageKey); } catch (e) { log('R2 delete failed:', e && e.message); }
      } else {
        log('R2 file removed from meta but R2 unavailable, object left in bucket:', item.storageKey);
      }
    } else {
      try { await deps.local.delete(item.storageKey); } catch {}
    }
    try { await deps.local.deleteThumb(item.id); } catch {}
    await deps.meta.deleteFile(id);
    const share = await deps.meta.getShareByFileId(id);
    if (share) await deps.meta.deleteShare(share.token);
    log('deleted:', item.name);
    return c.json({ ok: true });
  });
}
