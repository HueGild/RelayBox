// RelayBox core routes — chunked upload (chunk / chunk-status / chunk-complete).
// Captures uploadIp, uploadGeo, width, height on chunk-complete (v3.1.5).

import { readJsonBody, kindOf, extOf, keyOf, safeName, parseDim, parseExpiresHours, expiresAtOf, newId, CHUNK_SIZE, MIN_FREE_BYTES, MIME, log } from '../lib/util.js';
import { authOrPassword, authFail, clientMeta } from '../lib/auth.js';

export function registerChunks(app) {
  app.post('/api/upload/chunk', async (c) => {
    const deps = c.get('deps');
    const chunkSize = Number(deps.config.chunkSize) > 0 ? Number(deps.config.chunkSize) : CHUNK_SIZE;
    if (deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }
    const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
    if (auth !== 'ok') return authFail(c, auth);
    const q = c.req.query();
    const uploadId = (q.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const index = Number(q.index);
    const total = Number(q.total);
    const name = safeName(q.name || '');
    const size = Number(q.size);
    if (!uploadId || !Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total || !name || !Number.isFinite(size) || size <= 0 || size > deps.config.maxUploadSize) {
      return c.json({ ok: false, error: '参数不对' }, 400);
    }
    const chunks = [];
    let len = 0;
    try {
      const rawBody = c.req.raw.body;
      const reader = rawBody ? rawBody.getReader() : null;
      if (!reader) throw new Error('no body');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        len += value.length;
        if (len > chunkSize + 1024 * 1024) return c.json({ ok: false, error: '分片太大' }, 413);
      }
    } catch (e) {
      return c.json({ ok: false, error: '读取分片失败' }, 400);
    }
    const buf = Buffer.concat(chunks);
    const expect = index === total - 1 ? size - index * chunkSize : chunkSize;
    if (buf.length !== expect) return c.json({ ok: false, error: '分片大小不对' }, 400);
    let meta = await deps.meta.getChunkUpload(uploadId);
    if (!meta) {
      meta = {
        uploadId, r2UploadId: null, storageKey: null, name, size, total, chunkSize,
        visibility: q.visibility === 'public' ? 'public' : 'private',
        expiresHours: parseExpiresHours(q.expires || '0'),
        storage: q.storage === 'r2' && deps.r2.enabled ? 'r2' : 'local',
        folderId: q.folderId || null,
        createdAt: Date.now(), received: [],
      };
      await deps.meta.createChunkUpload(meta);
    }
    if (meta.name !== name || meta.size !== size || meta.total !== total) {
      return c.json({ ok: false, error: '分片信息和首次不一致' }, 400);
    }
    const updated = await deps.meta.writeChunkPart(uploadId, index, buf);
    return c.json({ ok: true, received: index, done: updated.received.length, total });
  });

  app.get('/api/upload/chunk-status', async (c) => {
    const deps = c.get('deps');
    const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
    if (auth !== 'ok') return authFail(c, auth);
    const uploadId = (c.req.query('uploadId') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const meta = uploadId ? await deps.meta.getChunkUpload(uploadId) : null;
    if (!meta) return c.json({ ok: true, received: [], meta: null });
    return c.json({
      ok: true,
      received: meta.received.map((r) => r.partNumber),
      meta: { name: meta.name, size: meta.size, total: meta.total },
    });
  });

  app.post('/api/upload/chunk-complete', async (c) => {
    const deps = c.get('deps');
    const body = await readJsonBody(c);
    const cleanId = String(body.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);
    const meta = cleanId ? await deps.meta.getChunkUpload(cleanId) : null;
    if (!meta) return c.json({ ok: false, error: '上传任务不存在或已过期' }, 404);
    for (let i = 0; i < meta.total; i++) {
      if (!meta.received.some((r) => r.partNumber === i) || !(await deps.meta.chunkPartExists(cleanId, i))) {
        return c.json({ ok: false, error: `还缺第 ${i + 1} 片` }, 400);
      }
    }
    const id = newId();
    const ext = extOf(meta.name);
    const tmpPath = deps.local.tempFilePath(`.tmp-chunk-${id}`);
    try {
      const assembled = await deps.meta.assembleChunks(cleanId, tmpPath);
      if (assembled !== meta.size) throw new Error('assembled size mismatch');
      if (meta.r2UploadId) {
        await deps.r2.rename(meta.storageKey, keyOf(id, meta.name));
      } else if (meta.storage === 'r2') {
        if (!deps.r2.enabled) throw new Error('R2 未配置');
        await deps.r2.putFile(keyOf(id, meta.name), tmpPath, MIME[ext] || 'application/octet-stream');
        await deps.local.removeTempFile(tmpPath);
      } else {
        await deps.local.importTempFile(tmpPath, keyOf(id, meta.name));
      }
    } catch (e) {
      log('chunk assemble failed:', e && e.message);
      await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: '合并失败：' + (e && e.message) }, 500);
    }
    try { await deps.meta.deleteChunkUpload(cleanId); } catch {}
    const folders = await deps.meta.listFolders();
    const folderId = (typeof meta.folderId === 'string' && meta.folderId && folders.some((fd) => fd.id === meta.folderId)) ? meta.folderId : null;
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id, name: meta.name, size: meta.size, ext, kind: kindOf(ext),
      visibility: meta.visibility, storage: meta.storage, storageKey: keyOf(id, meta.name), folderId,
      expiresAt: expiresAtOf(meta.expiresHours),
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
    log('uploaded (chunked):', meta.name, (meta.size / 1024 / 1024).toFixed(2) + 'MB', meta.storage);
    return c.json({ ok: true, file: item });
  });
}
