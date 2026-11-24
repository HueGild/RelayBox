// RelayBox core routes — upload (local multipart / R2 presigned upload-url /
// upload-complete). Mirrors v2.8.4's handleUpload / handleUploadUrl /
// handleUploadComplete exactly. The local multipart path is VPS-only: the
// busboy streaming parser is injected via deps.parseMultipart (Node adapter);
// without it the endpoint answers 501.

import { readJsonBody, kindOf, safeName, extOf, keyOf, parseExpiresHours, expiresAtOf, newId, MIN_FREE_BYTES, log } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail } from '../lib/auth.js';

export function registerUpload(app) {
  // 上传：multipart/form-data，字段 password + 文件 file。
  // 密码字段可能比文件流后到，所以先把文件写临时文件，收完再验密码，错了就删掉。
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
    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null; // 文件夹没了就放根目录
    const item = {
      id: file.id, name: file.name, size: file.size,
      ext: file.ext, kind: kindOf(file.ext),
      visibility: fields.visibility === 'public' ? 'public' : 'private',
      storage: 'local', storageKey: key, folderId,
      expiresAt: expiresAtOf(parseExpiresHours(fields.expires || '0')),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
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

  // R2 直传第一步：验密码/登录态后，签一个 15 分钟有效的 PUT 链接，浏览器直接传给 R2。
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

  // R2 直传第二步：浏览器传完后登记。先向 R2 核对大小，确认无误才写入元数据。
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
    if (existing) return c.json({ ok: true, file: existing }); // 幂等：重复确认直接返回
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
    const item = {
      id: body.id, name: filename, size: n, ext, kind: kindOf(ext),
      visibility: body.visibility === 'public' ? 'public' : 'private', storage: 'r2',
      storageKey: body.key, folderId,
      expiresAt: expiresAtOf(parseExpiresHours(body.expires)),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
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
}
