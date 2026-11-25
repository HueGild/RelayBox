// RelayBox core routes — file collection boxes / drop links (v3.3.1).
// Uses the pre-created drop_links table (zero D1 migration needed).
// Visitors can submit files into an admin-designated folder without logging in
// or seeing any existing files inside that folder (strictly write-only).

import {
  readJsonBody, newToken, newId, sha256Hex, safeName, extOf, kindOf, keyOf,
  parseDim, isExpired, CHUNK_SIZE, MIN_FREE_BYTES, MIME, log,
} from '../lib/util.js';
import { isAuthed, isBlocked, clientIp, clientMeta, recordFailureWithAlert } from '../lib/auth.js';
import { notifyDropUpload } from '../lib/notify.js';
import { buildPoolSummaries, resolveUploadTarget } from './pools.js';

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MIN_MAX_FILE_SIZE = 1 * 1024 * 1024;       // 1MB
const MAX_EXPIRES_HOURS = 365 * 24;              // 1 year

async function hashDropPassword(token, password) {
  const pw = String(password || '').trim();
  if (!pw) return '';
  return sha256Hex(`drop:${token}:${pw}`);
}

function dropExpired(d) {
  return !!(d && d.expiresAt && Date.now() > new Date(d.expiresAt).getTime());
}

function dropFull(d) {
  return !!(d && d.maxFiles > 0 && d.usedFiles >= d.maxFiles);
}

function formatDropFilename(rawName, senderRaw) {
  const cleanFile = safeName(rawName || 'file');
  const sender = String(senderRaw || '').trim().replace(/[/\\?%*:|"<>]/g, '_').slice(0, 24);
  if (!sender) return cleanFile;
  return safeName(`${sender}_${cleanFile}`);
}

async function resolveDefaultTarget(deps) {
  const summary = await buildPoolSummaries(deps, [], { authed: false, includeAdminMeta: false });
  return resolveUploadTarget(deps, summary.defaultPoolId);
}

async function verifyDropForUpload(c, deps, token, password) {
  const drop = await deps.meta.getDropLink(token);
  if (!drop) return { ok: false, status: 404, error: '收集箱不存在或已关闭' };
  if (dropExpired(drop)) return { ok: false, status: 410, error: '该文件收集箱已过期' };
  if (dropFull(drop)) return { ok: false, status: 410, error: '该文件收集箱份数已满' };

  if (drop.passwordHash) {
    const ip = clientIp(c, deps);
    if (await isBlocked(deps, ip)) {
      return { ok: false, status: 429, error: '尝试太频繁，10 分钟后再试' };
    }
    const supplied = String(password || '').trim();
    if (!supplied) {
      return { ok: false, status: 403, error: '需要提交口令', needPassword: true };
    }
    const expected = await hashDropPassword(drop.token, supplied);
    if (expected !== drop.passwordHash) {
      await recordFailureWithAlert(deps, ip, c, '收集箱口令校验');
      return { ok: false, status: 403, error: '提交口令不正确', needPassword: true };
    }
  }
  return { ok: true, drop };
}

async function fireDropNotify(deps, c, drop, item, usedFiles) {
  let folderName = '根目录';
  if (item.folderId) {
    try {
      const fd = await deps.meta.getFolder(item.folderId);
      if (fd && fd.name) folderName = fd.name;
    } catch {}
  }
  notifyDropUpload(deps, c, {
    dropTitle: drop.title,
    fileName: item.name,
    size: item.size,
    folderName,
    usedFiles,
    maxFiles: drop.maxFiles || 0,
    ip: item.uploadIp,
    geo: item.uploadGeo,
  });
}

function adminDropView(d, folderMap) {
  return {
    token: d.token,
    title: d.title,
    folderId: d.folderId || null,
    folderName: d.folderId ? (folderMap.get(d.folderId) || '已删除目录') : '根目录',
    hasPassword: !!d.passwordHash,
    maxFiles: d.maxFiles || 0,
    usedFiles: d.usedFiles || 0,
    maxFileSize: d.maxFileSize || DEFAULT_MAX_FILE_SIZE,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    expiresAt: d.expiresAt || null,
    expired: dropExpired(d),
    full: dropFull(d),
    createdAt: d.createdAt,
  };
}

export function registerDrops(app) {
  // ---- 管理员接口 ----
  app.get('/api/drops', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const [drops, folders] = await Promise.all([
      deps.meta.listDropLinks(),
      deps.meta.listFolders(),
    ]);
    const folderMap = new Map(folders.map((f) => [f.id, f.name]));
    return c.json({
      ok: true,
      drops: drops.map((d) => adminDropView(d, folderMap)),
    });
  });

  app.post('/api/drops', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const title = String(body.title || '').trim().slice(0, 60) || '文件收集';
    let folderId = (typeof body.folderId === 'string' && body.folderId.trim()) ? body.folderId.trim() : null;
    let folderName = '根目录';
    if (folderId) {
      const fd = await deps.meta.getFolder(folderId);
      if (!fd) return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
      folderName = fd.name;
    }
    const maxFilesRaw = Number(body.maxFiles);
    const maxFiles = (Number.isFinite(maxFilesRaw) && maxFilesRaw >= 0) ? Math.min(100000, Math.floor(maxFilesRaw)) : 0;
    const siteMax = deps.config.maxUploadSize || 5 * 1024 * 1024 * 1024;
    const maxSizeRaw = Number(body.maxFileSize);
    const maxFileSize = (Number.isFinite(maxSizeRaw) && maxSizeRaw > 0)
      ? Math.max(MIN_MAX_FILE_SIZE, Math.min(siteMax, Math.floor(maxSizeRaw)))
      : Math.min(DEFAULT_MAX_FILE_SIZE, siteMax);
    const visibility = body.visibility === 'public' ? 'public' : 'private';
    const expHoursRaw = Number(body.expiresHours);
    const expiresHours = (Number.isFinite(expHoursRaw) && expHoursRaw > 0)
      ? Math.min(MAX_EXPIRES_HOURS, Math.floor(expHoursRaw))
      : 0;
    const expiresAt = expiresHours > 0 ? new Date(Date.now() + expiresHours * 3600 * 1000).toISOString() : null;
    const token = newToken();
    const password = typeof body.password === 'string' ? body.password.trim().slice(0, 64) : '';
    const passwordHash = await hashDropPassword(token, password);

    const created = await deps.meta.createDropLink({
      token,
      folderId,
      title,
      passwordHash,
      maxFiles,
      usedFiles: 0,
      maxFileSize,
      visibility,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    log('drop link created:', created.title, created.token, folderName);
    const folderMap = new Map(folderId ? [[folderId, folderName]] : []);
    return c.json({ ok: true, drop: adminDropView(created, folderMap) });
  });

  app.delete('/api/drops/:token', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const token = decodeURIComponent(c.req.param('token'));
    const deleted = await deps.meta.deleteDropLink(token);
    if (!deleted) return c.json({ ok: false, error: '收集箱不存在' }, 404);
    log('drop link deleted:', token);
    return c.json({ ok: true });
  });

  // ---- 访客公开投递接口（严格只写不读，绝不暴露目录内容） ----
  app.get('/api/drop/:token', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const drop = await deps.meta.getDropLink(token);
    if (!drop) return c.json({ ok: false, error: '收集箱不存在或已关闭' }, 404);
    if (dropExpired(drop)) return c.json({ ok: false, error: '该文件收集箱已过期' }, 410);
    if (dropFull(drop)) return c.json({ ok: false, error: '该文件收集箱份数已满' }, 410);

    const supplied = (c.req.header('X-Drop-Password') || c.req.query('password') || '').trim();
    const needPassword = !!drop.passwordHash;
    let unlocked = !needPassword;

    if (needPassword && supplied) {
      const ip = clientIp(c, deps);
      if (await isBlocked(deps, ip)) {
        return c.json({ ok: false, error: '尝试太频繁，10 分钟后再试' }, 429);
      }
      const expected = await hashDropPassword(drop.token, supplied);
      if (expected !== drop.passwordHash) {
        await recordFailureWithAlert(deps, ip, c, '收集箱口令校验');
        return c.json({ ok: false, error: '提交口令不正确', needPassword: true }, 403);
      }
      unlocked = true;
    }

    const target = await resolveDefaultTarget(deps);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 503);
    const chunkSize = deps.config.chunkSize || CHUNK_SIZE;
    const proxyMaxBytes = Number(deps.config.proxyUploadMaxBytes) > 0
      ? Number(deps.config.proxyUploadMaxBytes)
      : 20 * 1024 * 1024;
    const presignThreshold = deps.config.chunkUploadThreshold || 32 * 1024 * 1024;

    return c.json({
      ok: true,
      drop: {
        token: drop.token,
        title: drop.title,
        needPassword,
        unlocked,
        maxFiles: drop.maxFiles || 0,
        usedFiles: drop.usedFiles || 0,
        maxFileSize: drop.maxFileSize || DEFAULT_MAX_FILE_SIZE,
        expiresAt: drop.expiresAt || null,
        uploadMode: target.transferMode, // 'proxy' | 'presign' | 'local'
        proxyMaxBytes,
        chunkUploadThreshold: target.transferMode === 'proxy' ? proxyMaxBytes : presignThreshold,
        chunkSize,
      },
    });
  });

  // 1) 中转上传（CF 绑定 / 外挂 S3 中转模式，单文件 <= 20MB）
  app.post('/api/drop/:token/upload-proxy', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const check = await verifyDropForUpload(c, deps, token, c.req.header('X-Drop-Password') || '');
    if (!check.ok) {
      return c.json({ ok: false, error: check.error, ...(check.needPassword ? { needPassword: true } : {}) }, check.status);
    }
    const { drop } = check;
    const target = await resolveDefaultTarget(deps);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 503);
    if (!target.driver.proxySupported) {
      return c.json({ ok: false, error: '当前存储池不支持中转上传' }, 501);
    }
    const q = c.req.query();
    const maxProxyBytes = Number(deps.config.proxyUploadMaxBytes) > 0
      ? Number(deps.config.proxyUploadMaxBytes)
      : 20 * 1024 * 1024;
    const filename = formatDropFilename(q.name || '', q.sender || '');
    const declaredSize = Number(q.size);
    if (!filename || !Number.isFinite(declaredSize) || declaredSize <= 0) {
      return c.json({ ok: false, error: '文件名或大小不对' }, 400);
    }
    if (declaredSize > drop.maxFileSize) {
      return c.json({ ok: false, error: '文件超出该收集箱的单文件大小限制' }, 413);
    }
    if (declaredSize > maxProxyBytes) {
      return c.json({ ok: false, error: '文件超过中转单次上限，请使用分片上传' }, 413);
    }
    let bytes;
    try {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    } catch {
      return c.json({ ok: false, error: '读取文件失败' }, 400);
    }
    if (!bytes || bytes.byteLength <= 0) return c.json({ ok: false, error: '没有收到文件' }, 400);
    if (bytes.byteLength > drop.maxFileSize || bytes.byteLength > maxProxyBytes) {
      return c.json({ ok: false, error: '文件超出大小限制' }, 413);
    }
    if (bytes.byteLength !== declaredSize) {
      return c.json({ ok: false, error: '文件大小和申报的不一致' }, 400);
    }

    const ext = extOf(filename);
    const mime = MIME[ext] || (c.req.header('Content-Type') || '').split(';')[0].trim() || 'application/octet-stream';
    const id = newId();
    const key = keyOf(id, filename);
    let folderId = drop.folderId || null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;

    try {
      await target.driver.put(key, bytes, mime);
    } catch (e) {
      log('drop upload-proxy put failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }

    const inc = await deps.meta.incrementDropLinkFiles(drop.token);
    if (inc === 0) {
      try { await target.driver.delete(key); } catch {}
      return c.json({ ok: false, error: '该文件收集箱份数已满' }, 410);
    }

    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id, name: filename, size: bytes.byteLength, ext, kind: kindOf(ext),
      visibility: drop.visibility, storage: 'r2', storageKey: key, folderId,
      expiresAt: null,
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(q.width),
      height: parseDim(q.height),
      poolId: target.poolId,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('drop meta save failed:', e && e.message);
      try { await target.driver.delete(key); } catch {}
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('drop uploaded (proxy):', drop.title, filename, (bytes.byteLength / 1024 / 1024).toFixed(2) + 'MB');
    await fireDropNotify(deps, c, drop, item, (drop.usedFiles || 0) + 1);
    return c.json({
      ok: true,
      file: { id: item.id, name: item.name, size: item.size },
      usedFiles: (drop.usedFiles || 0) + 1,
      maxFiles: drop.maxFiles || 0,
    });
  });

  // 2) 预签名直传（申请 URL）
  app.post('/api/drop/:token/upload-url', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const body = await readJsonBody(c);
    const check = await verifyDropForUpload(c, deps, token, body.password || '');
    if (!check.ok) {
      return c.json({ ok: false, error: check.error, ...(check.needPassword ? { needPassword: true } : {}) }, check.status);
    }
    const { drop } = check;
    const target = await resolveDefaultTarget(deps);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 503);
    if (!target.driver.presignEnabled) {
      return c.json({ ok: false, error: '当前存储池不支持预签名直传' }, 501);
    }
    const filename = formatDropFilename(body.name || '', body.sender || '');
    const n = Number(body.size);
    if (!filename || !Number.isFinite(n) || n <= 0) {
      return c.json({ ok: false, error: '文件名或大小不对' }, 400);
    }
    if (n > drop.maxFileSize) {
      return c.json({ ok: false, error: '文件超出该收集箱的单文件大小限制' }, 413);
    }
    const id = newId();
    const key = keyOf(id, filename);
    try {
      const url = await target.driver.presignedPutUrl(key, { contentLength: n, expiresIn: 900 });
      return c.json({ ok: true, id, key, name: filename, uploadUrl: url, expiresIn: 900, poolId: target.poolId });
    } catch (e) {
      log('drop presign PUT failed:', e && e.message);
      return c.json({ ok: false, error: '生成上传链接失败' }, 500);
    }
  });

  // 3) 预签名直传（登记完成）
  app.post('/api/drop/:token/upload-complete', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const body = await readJsonBody(c);
    const check = await verifyDropForUpload(c, deps, token, body.password || '');
    if (!check.ok) {
      return c.json({ ok: false, error: check.error, ...(check.needPassword ? { needPassword: true } : {}) }, check.status);
    }
    const { drop } = check;
    const target = await resolveUploadTarget(deps, body.poolId, 'r2');
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 503);
    const filename = safeName(body.name || '');
    const ext = extOf(filename);
    const n = Number(body.size);
    if (!body.id || !body.key || body.key !== keyOf(body.id, filename) || !Number.isFinite(n) || n <= 0 || n > drop.maxFileSize) {
      return c.json({ ok: false, error: '参数不对' }, 400);
    }
    const existing = await deps.meta.getFile(body.id);
    if (existing) return c.json({ ok: true, file: { id: existing.id, name: existing.name, size: existing.size }, usedFiles: drop.usedFiles, maxFiles: drop.maxFiles });
    let head;
    try {
      head = await target.driver.head(body.key);
    } catch {
      return c.json({ ok: false, error: '存储桶里没有这个文件，请重新上传' }, 400);
    }
    if (!head) return c.json({ ok: false, error: '存储桶里没有这个文件，请重新上传' }, 400);
    if (Number(head.size) !== n) {
      try { await target.driver.delete(body.key); } catch {}
      return c.json({ ok: false, error: '文件大小和申报的不一致，已取消登记' }, 400);
    }
    const inc = await deps.meta.incrementDropLinkFiles(drop.token);
    if (inc === 0) {
      try { await target.driver.delete(body.key); } catch {}
      return c.json({ ok: false, error: '该文件收集箱份数已满' }, 410);
    }
    let folderId = drop.folderId || null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id: body.id, name: filename, size: n, ext, kind: kindOf(ext),
      visibility: drop.visibility, storage: 'r2', storageKey: body.key, folderId,
      expiresAt: null,
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(body.width),
      height: parseDim(body.height),
      poolId: target.poolId,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('drop upload-complete meta save failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('drop uploaded (presign):', drop.title, filename, (n / 1024 / 1024).toFixed(2) + 'MB');
    await fireDropNotify(deps, c, drop, item, (drop.usedFiles || 0) + 1);
    return c.json({
      ok: true,
      file: { id: item.id, name: item.name, size: item.size },
      usedFiles: (drop.usedFiles || 0) + 1,
      maxFiles: drop.maxFiles || 0,
    });
  });

  // 4) VPS 本地磁盘直传（Node multipart）
  app.post('/api/drop/:token/upload', async (c) => {
    const deps = c.get('deps');
    if (deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }
    if (!deps.parseMultipart) {
      return c.json({ ok: false, error: '当前部署环境不支持本地上传' }, 501);
    }
    const token = decodeURIComponent(c.req.param('token'));
    const dropPre = await deps.meta.getDropLink(token);
    if (!dropPre) return c.json({ ok: false, error: '收集箱不存在或已关闭' }, 404);
    const { fields, file, failed, tmpPath } = await deps.parseMultipart(c, {
      maxFileSize: dropPre.maxFileSize || DEFAULT_MAX_FILE_SIZE,
      filesDir: deps.local.filesDir,
    });
    if (failed || !file) {
      if (tmpPath) await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: failed ? '文件超出大小限制或上传失败' : '没有收到文件' }, 400);
    }
    const check = await verifyDropForUpload(c, deps, token, fields.password || '');
    if (!check.ok) {
      await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: check.error, ...(check.needPassword ? { needPassword: true } : {}) }, check.status);
    }
    const { drop } = check;
    const filename = formatDropFilename(file.name, fields.sender || '');
    const ext = extOf(filename);
    const key = keyOf(file.id, filename);
    const inc = await deps.meta.incrementDropLinkFiles(drop.token);
    if (inc === 0) {
      await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: '该文件收集箱份数已满' }, 410);
    }
    try {
      await deps.local.importTempFile(tmpPath, key);
    } catch (e) {
      log('drop local rename failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    let folderId = drop.folderId || null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id: file.id, name: filename, size: file.size, ext, kind: kindOf(ext),
      visibility: drop.visibility, storage: 'local', storageKey: key, folderId,
      expiresAt: null,
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(fields.width),
      height: parseDim(fields.height),
      poolId: null,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('drop local meta save failed:', e && e.message);
      try { await deps.local.delete(key); } catch {}
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('drop uploaded (local):', drop.title, filename, (file.size / 1024 / 1024).toFixed(2) + 'MB');
    await fireDropNotify(deps, c, drop, item, (drop.usedFiles || 0) + 1);
    return c.json({
      ok: true,
      file: { id: item.id, name: item.name, size: item.size },
      usedFiles: (drop.usedFiles || 0) + 1,
      maxFiles: drop.maxFiles || 0,
    });
  });

  // 5) 分片上传（中转模式 > 20MB 或大文件收集）
  app.post('/api/drop/:token/chunk', async (c) => {
    const deps = c.get('deps');
    const chunkSize = Number(deps.config.chunkSize) > 0 ? Number(deps.config.chunkSize) : CHUNK_SIZE;
    if (deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }
    const token = decodeURIComponent(c.req.param('token'));
    const check = await verifyDropForUpload(c, deps, token, c.req.header('X-Drop-Password') || '');
    if (!check.ok) {
      return c.json({ ok: false, error: check.error, ...(check.needPassword ? { needPassword: true } : {}) }, check.status);
    }
    const { drop } = check;
    const q = c.req.query();
    const rawUploadId = (q.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    const uploadId = rawUploadId ? `drop_${drop.token}_${rawUploadId}`.slice(0, 64) : '';
    const index = Number(q.index);
    const total = Number(q.total);
    const name = formatDropFilename(q.name || '', q.sender || '');
    const size = Number(q.size);
    if (!uploadId || !Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total || !name || !Number.isFinite(size) || size <= 0 || size > drop.maxFileSize) {
      return c.json({ ok: false, error: '参数不对或超出大小限制' }, 400);
    }
    const chunks = [];
    let len = 0;
    try {
      const reader = c.req.raw.body ? c.req.raw.body.getReader() : null;
      if (!reader) throw new Error('no body');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        len += value.length;
        if (len > chunkSize + 1024 * 1024) return c.json({ ok: false, error: '分片太大' }, 413);
      }
    } catch {
      return c.json({ ok: false, error: '读取分片失败' }, 400);
    }
    const buf = new Uint8Array(len);
    let offset = 0;
    for (const part of chunks) { buf.set(part, offset); offset += part.length; }
    const expect = index === total - 1 ? size - index * chunkSize : chunkSize;
    if (buf.byteLength !== expect) return c.json({ ok: false, error: '分片大小不对' }, 400);

    let meta = await deps.meta.getChunkUpload(uploadId);
    let targetDriver = null;
    if (!meta) {
      const target = await resolveDefaultTarget(deps);
      if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 503);
      targetDriver = target.driver;
      meta = {
        uploadId, r2UploadId: null, storageKey: null, name, size, total, chunkSize,
        visibility: drop.visibility,
        expiresHours: 0,
        storage: target.storage,
        poolId: target.poolId,
        folderId: drop.folderId || null,
        createdAt: Date.now(), received: [],
      };
      await deps.meta.createChunkUpload(meta);
    } else if (meta.poolId) {
      const resolved = await resolveUploadTarget(deps, meta.poolId, 'r2');
      if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 400);
      targetDriver = resolved.driver;
    } else if (meta.storage === 'r2') {
      targetDriver = deps.r2;
    }

    if (meta.name !== name || meta.size !== size || meta.total !== total) {
      return c.json({ ok: false, error: '分片信息和首次不一致' }, 400);
    }
    const updated = await deps.meta.writeChunkPart(uploadId, index, buf, targetDriver);
    return c.json({ ok: true, received: index, done: updated.received.length, total });
  });

  app.post('/api/drop/:token/chunk-complete', async (c) => {
    const deps = c.get('deps');
    const token = decodeURIComponent(c.req.param('token'));
    const body = await readJsonBody(c);
    const check = await verifyDropForUpload(c, deps, token, body.password || '');
    if (!check.ok) {
      return c.json({ ok: false, error: check.error, ...(check.needPassword ? { needPassword: true } : {}) }, check.status);
    }
    const { drop } = check;
    const rawUploadId = String(body.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    const cleanId = rawUploadId ? `drop_${drop.token}_${rawUploadId}`.slice(0, 64) : '';
    const meta = cleanId ? await deps.meta.getChunkUpload(cleanId) : null;
    if (!meta) return c.json({ ok: false, error: '上传任务不存在或已过期' }, 404);
    for (let i = 0; i < meta.total; i++) {
      if (!meta.received.some((r) => r.partNumber === i) || !(await deps.meta.chunkPartExists(cleanId, i))) {
        return c.json({ ok: false, error: `还缺第 ${i + 1} 片` }, 400);
      }
    }
    const inc = await deps.meta.incrementDropLinkFiles(drop.token);
    if (inc === 0) return c.json({ ok: false, error: '该文件收集箱份数已满' }, 410);

    const id = newId();
    const ext = extOf(meta.name);
    const finalKey = keyOf(id, meta.name);
    const mime = MIME[ext] || 'application/octet-stream';
    const tmpPath = deps.local.tempFilePath(`.tmp-drop-${id}`);
    let poolDriver = null;
    if (meta.poolId) {
      const resolved = await resolveUploadTarget(deps, meta.poolId, 'r2');
      if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 400);
      poolDriver = resolved.driver;
    }
    try {
      if (meta.r2UploadId) {
        const drv = poolDriver || deps.r2;
        const assembled = await deps.meta.assembleChunks(cleanId, tmpPath, drv);
        if (assembled !== meta.size) throw new Error('assembled size mismatch');
        await drv.rename(meta.storageKey, finalKey);
      } else if (poolDriver) {
        if (meta.total === 1) {
          const part0 = await deps.meta.readChunkPart(cleanId, 0);
          if (!part0 || part0.length !== meta.size) throw new Error('assembled size mismatch');
          await poolDriver.put(finalKey, part0, mime);
        } else {
          const mpuId = await poolDriver.createMultipartUpload(finalKey, mime);
          const parts = [];
          try {
            let totalBytes = 0;
            for (let i = 0; i < meta.total; i++) {
              const partBuf = await deps.meta.readChunkPart(cleanId, i);
              if (!partBuf) throw new Error(`missing chunk ${i}`);
              totalBytes += partBuf.length;
              const { etag } = await poolDriver.uploadPart(mpuId, finalKey, i + 1, partBuf);
              parts.push({ partNumber: i + 1, etag });
            }
            if (totalBytes !== meta.size) throw new Error('assembled size mismatch');
            await poolDriver.completeMultipartUpload(mpuId, finalKey, parts);
          } catch (err) {
            try { await poolDriver.abortMultipartUpload(mpuId, finalKey); } catch {}
            throw err;
          }
        }
      } else {
        const assembled = await deps.meta.assembleChunks(cleanId, tmpPath);
        if (assembled !== meta.size) throw new Error('assembled size mismatch');
        if (meta.storage === 'r2') {
          await deps.r2.putFile(finalKey, tmpPath, mime);
          await deps.local.removeTempFile(tmpPath);
        } else {
          await deps.local.importTempFile(tmpPath, finalKey);
        }
      }
    } catch (e) {
      log('drop chunk assemble failed:', e && e.message);
      await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: '合并失败：' + (e && e.message) }, 500);
    }
    try { await deps.meta.deleteChunkUpload(cleanId, poolDriver || deps.r2); } catch {}
    let folderId = drop.folderId || null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id, name: meta.name, size: meta.size, ext, kind: kindOf(ext),
      visibility: drop.visibility, storage: meta.storage, storageKey: finalKey, folderId,
      expiresAt: null,
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(body.width),
      height: parseDim(body.height),
      poolId: meta.poolId || null,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('drop chunk meta save failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('drop uploaded (chunked):', drop.title, meta.name, (meta.size / 1024 / 1024).toFixed(2) + 'MB');
    await fireDropNotify(deps, c, drop, item, (drop.usedFiles || 0) + 1);
    return c.json({
      ok: true,
      file: { id: item.id, name: item.name, size: item.size },
      usedFiles: (drop.usedFiles || 0) + 1,
      maxFiles: drop.maxFiles || 0,
    });
  });
}
