// RelayBox core routes — geek one-click upload (v3.1 + v3.1.5 uploader meta).
// POST /api/raw-upload: API Token auth (Bearer or ?token), small file (<=32MB)
// straight to R2 via the injected StorageStore (deps.r2.put).

import { kindOf, safeName, extOf, keyOf, parseDim, expiresAtOf, newId, sha256Hex, MIME, log } from '../lib/util.js';
import { clientMeta } from '../lib/auth.js';
import { resolveUploadTarget } from './pools.js';

const RAW_UPLOAD_MAX_BYTES = 32 * 1024 * 1024; // 32MB

export function registerRawUpload(app) {
  app.post('/api/raw-upload', async (c) => {
    const deps = c.get('deps');
    const reqPoolId = (c.req.query('poolId') || c.req.header('X-Pool-Id') || '').trim();
    const target = await resolveUploadTarget(deps, reqPoolId, 'r2');
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 501);

    const authHeader = c.req.header('Authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
    const rawToken = (bearer ? bearer[1].trim() : '') || (c.req.query('token') || '').trim();
    if (!rawToken) return c.json({ ok: false, error: '需要 API Token' }, 401);
    const tokenHash = await sha256Hex(rawToken);
    const apiToken = await deps.meta.getApiTokenByHash(tokenHash);
    if (!apiToken) return c.json({ ok: false, error: 'API Token 不对' }, 401);
    deps.meta.touchApiToken(apiToken.id).catch(() => {});

    const q = (name) => c.req.query(name);
    const h = (name) => c.req.header(name);
    let folderId = (q('folderId') || h('X-Folder-Id') || '').trim() || null;
    let visibility = (q('visibility') || h('X-Visibility') || '').trim().toLowerCase();
    visibility = visibility === 'private' ? 'private' : 'public';
    const expiresRaw = Number(q('expires') ?? h('X-Expires') ?? 0);
    const expiresHours = Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.floor(expiresRaw) : 0;
    const format = (q('format') || h('X-Format') || 'json').trim().toLowerCase();
    const width = parseDim(q('width') ?? h('X-Width'));
    const height = parseDim(q('height') ?? h('X-Height'));

    const contentType = (c.req.header('Content-Type') || '').toLowerCase();
    const isMultipart = contentType.includes('multipart/form-data');
    if (!isMultipart) {
      const contentLength = Number(c.req.header('Content-Length') || 0);
      if (Number.isFinite(contentLength) && contentLength > RAW_UPLOAD_MAX_BYTES) {
        return c.json({ ok: false, error: '文件超过 32MB，请改用网页端分片上传' }, 413);
      }
    }

    let filename = '';
    let fileBytes = null;
    let fileType = '';
    if (isMultipart) {
      let parsed;
      try {
        parsed = await c.req.parseBody();
      } catch (e) {
        return c.json({ ok: false, error: '表单解析失败' }, 400);
      }
      let fileVal = parsed && parsed.file;
      if (Array.isArray(fileVal)) fileVal = fileVal[0];
      if (!fileVal || typeof fileVal !== 'object' || typeof fileVal.arrayBuffer !== 'function') {
        for (const v of Object.values(parsed || {})) {
          const cand = Array.isArray(v) ? v[0] : v;
          if (cand && typeof cand === 'object' && typeof cand.arrayBuffer === 'function') { fileVal = cand; break; }
        }
      }
      if (!fileVal || typeof fileVal.arrayBuffer !== 'function') {
        return c.json({ ok: false, error: '没有收到文件' }, 400);
      }
      filename = safeName(fileVal.name || '');
      fileType = fileVal.type || '';
      const buf = await fileVal.arrayBuffer();
      fileBytes = new Uint8Array(buf);
      if (!folderId && typeof parsed.folderId === 'string') folderId = parsed.folderId.trim() || null;
      if (typeof parsed.visibility === 'string' && parsed.visibility) {
        visibility = parsed.visibility.trim().toLowerCase() === 'private' ? 'private' : 'public';
      }
    } else {
      filename = safeName(h('X-Filename') || '');
      if (!filename || filename === 'file') {
        const disp = h('Content-Disposition') || '';
        const m = /filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i.exec(disp);
        if (m) filename = safeName(decodeURIComponent(m[1].replace(/"/g, '')));
      }
      if (!filename) filename = 'file';
      const buf = await c.req.arrayBuffer();
      fileBytes = new Uint8Array(buf);
      fileType = contentType.split(';')[0].trim();
    }

    if (!fileBytes || fileBytes.byteLength <= 0) {
      return c.json({ ok: false, error: '没有收到文件' }, 400);
    }
    if (fileBytes.byteLength > RAW_UPLOAD_MAX_BYTES) {
      return c.json({ ok: false, error: '文件超过 32MB，请改用网页端分片上传' }, 413);
    }

    if (folderId && !(await deps.meta.getFolder(folderId))) folderId = null;
    const ext = extOf(filename);
    const mime = MIME[ext] || fileType || 'application/octet-stream';
    const id = newId();
    const key = keyOf(id, filename);
    try {
      await target.driver.put(key, fileBytes, mime);
    } catch (e) {
      log('raw-upload R2 put failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id, name: filename, size: fileBytes.byteLength, ext, kind: kindOf(ext),
      visibility, storage: 'r2', storageKey: key, folderId,
      expiresAt: expiresAtOf(expiresHours),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width, height,
      poolId: target.poolId,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('raw-upload meta save failed:', e && e.message);
      try { await target.driver.delete(key); } catch {}
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    log('raw-upload:', filename, (item.size / 1024 / 1024).toFixed(2) + 'MB', 'token', apiToken.prefix);
    const origin = new URL(c.req.url).origin;
    const url = `${origin}/f/${id}`;
    if (format === 'text') {
      return new Response(url, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return c.json({ ok: true, file: item, url });
  });
}
