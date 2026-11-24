// RelayBox core routes — upload (local multipart / R2 presigned upload-url /
// upload-complete). Captures uploadIp, uploadGeo, width, height (v3.1.5).

import { readJsonBody, kindOf, safeName, extOf, keyOf, parseDim, parseExpiresHours, expiresAtOf, newId, MIN_FREE_BYTES, MIME, log } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail, clientMeta } from '../lib/auth.js';

export function registerUpload(app) {
  app.post('/api/upload', async (c) => {
    const deps = c.get('deps');
    if (deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }
    if (!deps.parseMultipart) {
      return c.json({ ok: false, error: '本地上传仅支持 VPS' }, 501);
    }
    const authed = await isAuthed(c, deps);
    const { fields, file, failed, tmpPath } = await deps.parseMultipart(c, {
      maxFileSize: deps.config.maxUploadSize,
      filesDir: deps.local.filesDir,
    });
    if (failed || !file) {
      if (tmpPath) await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: failed ? '上传失败' : '没有收到文件' }, 400);
    }
    if (!authed) {
      const auth = await authOrPassword(c, deps, fields.password || '');
      if (auth !== 'ok') {
        await deps.local.removeTempFile(tmpPath);
        return authFail(c, auth);
      }
    }
    const key = keyOf(file.id, file.name);
    try {
      await deps.local.importTempFile(tmpPath, key);
    } catch (e) {
      log('rename failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    let folderId = (typeof fields.folderId === 'string' && fields.folderId) ? fields.folderId : null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id: file.id, name: file.name, size: file.size,
      ext: file.ext, kind: kindOf(file.ext),
      visibility: fields.visibility === 'public' ? 'public' : 'private',
      storage: 'local', storageKey: key, folderId,
      expiresAt: expiresAtOf(parseExpiresHours(fields.expires || '0')),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(fields.width),
      height: parseDim(fields.height),
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('meta save failed:', e && e.message);
      try { await deps.local.delete(key); } catch {}
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('uploaded:', file.name, (file.size / 1024 / 1024).toFixed(2) + 'MB');
    return c.json({ ok: true, file: item });
  });

  app.post('/api/upload-url', async (c) => {
    const deps = c.get('deps');
    if (!deps.r2.enabled) return c.json({ ok: false, error: 'R2 未配置' }, 501);
    const body = await readJsonBody(c);
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);
    const filename = safeName(body.name);
    const ext = extOf(filename);
    const n = Number(body.size);
    if (!filename || !Number.isFinite(n) || n <= 0 || n > deps.config.maxUploadSize) {
      return c.json({ ok: false, error: '文件名或大小不对' }, 400);
    }
    const id = newId();
    const key = keyOf(id, filename);
    try {
      const url = await deps.r2.presignedPutUrl(key, { contentLength: n, expiresIn: 900 });
      return c.json({ ok: true, id, key, uploadUrl: url, expiresIn: 900 });
    } catch (e) {
      log('presign PUT failed:', e && e.message);
      return c.json({ ok: false, error: '生成上传链接失败' }, 500);
    }
  });

  app.post('/api/upload-complete', async (c) => {
    const deps = c.get('deps');
    if (!deps.r2.enabled) return c.json({ ok: false, error: 'R2 未配置' }, 501);
    const body = await readJsonBody(c);
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);
    const filename = safeName(body.name);
    const ext = extOf(filename);
    const n = Number(body.size);
    if (!body.id || !body.key || body.key !== keyOf(body.id, filename) || !Number.isFinite(n) || n <= 0 || n > deps.config.maxUploadSize) {
      return c.json({ ok: false, error: '参数不对' }, 400);
    }
    const existing = await deps.meta.getFile(body.id);
    if (existing) return c.json({ ok: true, file: existing });
    let head;
    try {
      head = await deps.r2.head(body.key);
    } catch (e) {
      log('R2 head failed:', e && e.message);
      return c.json({ ok: false, error: 'R2 里没有这个文件，请重新上传' }, 400);
    }
    if (!head) return c.json({ ok: false, error: 'R2 里没有这个文件，请重新上传' }, 400);
    if (Number(head.size) !== n) {
      try { await deps.r2.delete(body.key); } catch {}
      return c.json({ ok: false, error: '文件大小和申报的不一致，已取消登记' }, 400);
    }
    let folderId = (typeof body.folderId === 'string' && body.folderId) ? body.folderId : null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id: body.id, name: filename, size: n, ext, kind: kindOf(ext),
      visibility: body.visibility === 'public' ? 'public' : 'private', storage: 'r2',
      storageKey: body.key, folderId,
      expiresAt: expiresAtOf(parseExpiresHours(body.expires)),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(body.width),
      height: parseDim(body.height),
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('meta save failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('uploaded (r2):', filename, (n / 1024 / 1024).toFixed(2) + 'MB');
    return c.json({ ok: true, file: item });
  });

  // Worker 绑定中转直传（v3.1.6，图床模式：单文件 <= 20MB，零 S3 密钥、零 CORS）
  app.post('/api/upload-proxy', async (c) => {
    const deps = c.get('deps');
    if (!deps.r2.enabled || !deps.r2.proxySupported) {
      return c.json({ ok: false, error: '当前环境不支持中转上传' }, 501);
    }
    const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
    if (auth !== 'ok') return authFail(c, auth);
    const maxProxyBytes = Number(deps.config.proxyUploadMaxBytes) > 0
      ? Number(deps.config.proxyUploadMaxBytes)
      : 20 * 1024 * 1024;
    const q = c.req.query();
    const filename = safeName(q.name || '');
    const declaredSize = Number(q.size);
    if (!filename || !Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > deps.config.maxUploadSize) {
      return c.json({ ok: false, error: '文件名或大小不对' }, 400);
    }
    if (declaredSize > maxProxyBytes) {
      return c.json({ ok: false, error: '文件超过中转单次上限，请使用分片上传' }, 413);
    }
    const contentLength = Number(c.req.header('Content-Length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxProxyBytes) {
      return c.json({ ok: false, error: '文件超过中转单次上限，请使用分片上传' }, 413);
    }
    let bytes;
    try {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    } catch (e) {
      return c.json({ ok: false, error: '读取文件失败' }, 400);
    }
    if (!bytes || bytes.byteLength <= 0) {
      return c.json({ ok: false, error: '没有收到文件' }, 400);
    }
    if (bytes.byteLength > maxProxyBytes) {
      return c.json({ ok: false, error: '文件超过中转单次上限，请使用分片上传' }, 413);
    }
    if (bytes.byteLength !== declaredSize) {
      return c.json({ ok: false, error: '文件大小和申报的不一致' }, 400);
    }
    let folderId = (typeof q.folderId === 'string' && q.folderId) ? q.folderId : null;
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const ext = extOf(filename);
    const mime = MIME[ext] || (c.req.header('Content-Type') || '').split(';')[0].trim() || 'application/octet-stream';
    const id = newId();
    const key = keyOf(id, filename);
    try {
      await deps.r2.put(key, bytes, mime);
    } catch (e) {
      log('upload-proxy R2 put failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id, name: filename, size: bytes.byteLength, ext, kind: kindOf(ext),
      visibility: q.visibility === 'public' ? 'public' : 'private',
      storage: 'r2', storageKey: key, folderId,
      expiresAt: expiresAtOf(parseExpiresHours(q.expires || '0')),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(q.width),
      height: parseDim(q.height),
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('upload-proxy meta save failed:', e && e.message);
      try { await deps.r2.delete(key); } catch {}
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('uploaded (r2-proxy):', filename, (bytes.byteLength / 1024 / 1024).toFixed(2) + 'MB');
    return c.json({ ok: true, file: item });
  });
}
