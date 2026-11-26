// RelayBox core routes — chunked upload (chunk / chunk-status / chunk-complete).
// Supports built-in R2, built-in local disk (VPS), dynamic S3/R2 pools (v3.2), and sub-accounts (v3.8.0).

import { readJsonBody, kindOf, extOf, keyOf, safeName, parseDim, parseExpiresHours, expiresAtOf, newId, CHUNK_SIZE, MIN_FREE_BYTES, MIME, log } from '../lib/util.js';
import { getAuthContext, assertFolderInSubtree, checkUserQuota, auditUserPrefix, authOrPassword, authFail, clientMeta } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { resolveUploadTarget } from './pools.js';

export function registerChunks(app) {
  app.post('/api/upload/chunk', async (c) => {
    const deps = c.get('deps');
    const chunkSize = Number(deps.config.chunkSize) > 0 ? Number(deps.config.chunkSize) : CHUNK_SIZE;
    if (deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }
    const authCtx = await getAuthContext(c, deps);
    if (authCtx.user) {
      if (!authCtx.user.canUpload) return c.json({ ok: false, error: '当前账号没有上传权限' }, 403);
    } else if (!authCtx.isAdmin) {
      const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
      if (auth !== 'ok') return authFail(c, auth);
    }
    const q = c.req.query();
    const uploadId = (q.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const index = Number(q.index);
    const total = Number(q.total);
    const name = safeName(q.name || '');
    const size = Number(q.size);
    if (!uploadId || !Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total || !name || !Number.isFinite(size) || size <= 0 || size > deps.config.maxUploadSize) {
      return c.json({ ok: false, error: '参数不对' }, 400);
    }
    let reqFolderId = (typeof q.folderId === 'string' && q.folderId) ? q.folderId : null;
    if (authCtx.user) {
      if (!reqFolderId) reqFolderId = authCtx.user.rootFolderId;
      if (!(await assertFolderInSubtree(deps, reqFolderId, authCtx.user.rootFolderId))) {
        return c.json({ ok: false, error: '无权上传到该目录' }, 403);
      }
      const qCheck = await checkUserQuota(deps, authCtx.user, size);
      if (!qCheck.ok) {
        return c.json({ ok: false, error: '已超出账号空间配额' }, 413);
      }
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
    const buf = new Uint8Array(len);
    let offset = 0;
    for (const part of chunks) {
      buf.set(part, offset);
      offset += part.length;
    }
    const expect = index === total - 1 ? size - index * chunkSize : chunkSize;
    if (buf.byteLength !== expect) return c.json({ ok: false, error: '分片大小不对' }, 400);

    let meta = await deps.meta.getChunkUpload(uploadId);
    let targetDriver = null;
    if (!meta) {
      const reqPoolId = (typeof q.poolId === 'string' && q.poolId.trim()) ? q.poolId.trim() : '';
      let targetStorage = q.storage === 'r2' && deps.r2.enabled ? 'r2' : 'local';
      let poolId = null;
      if (reqPoolId) {
        const resolved = await resolveUploadTarget(deps, reqPoolId, q.storage);
        if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 400);
        targetStorage = resolved.storage;
        poolId = resolved.poolId;
        targetDriver = resolved.driver;
      } else if (targetStorage === 'r2') {
        targetDriver = deps.r2;
      }
      meta = {
        uploadId, r2UploadId: null, storageKey: null, name, size, total, chunkSize,
        visibility: q.visibility === 'public' ? 'public' : 'private',
        expiresHours: parseExpiresHours(q.expires || '0'),
        storage: targetStorage,
        poolId,
        folderId: reqFolderId,
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

    if (authCtx.user && !(await assertFolderInSubtree(deps, meta.folderId, authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权操作该上传任务' }, 403);
    }
    if (meta.name !== name || meta.size !== size || meta.total !== total) {
      return c.json({ ok: false, error: '分片信息和首次不一致' }, 400);
    }
    const updated = await deps.meta.writeChunkPart(uploadId, index, buf, targetDriver);
    return c.json({ ok: true, received: index, done: updated.received.length, total });
  });

  app.get('/api/upload/chunk-status', async (c) => {
    const deps = c.get('deps');
    const authCtx = await getAuthContext(c, deps);
    if (authCtx.user) {
      if (!authCtx.user.canUpload) return c.json({ ok: false, error: '当前账号没有上传权限' }, 403);
    } else if (!authCtx.isAdmin) {
      const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
      if (auth !== 'ok') return authFail(c, auth);
    }
    const uploadId = (c.req.query('uploadId') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const meta = uploadId ? await deps.meta.getChunkUpload(uploadId) : null;
    if (!meta) return c.json({ ok: true, received: [], meta: null });
    if (authCtx.user && !(await assertFolderInSubtree(deps, meta.folderId, authCtx.user.rootFolderId))) {
      return c.json({ ok: false, error: '无权查看该上传任务' }, 403);
    }
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
    const authCtx = await getAuthContext(c, deps);
    if (authCtx.user) {
      if (!authCtx.user.canUpload) return c.json({ ok: false, error: '当前账号没有上传权限' }, 403);
    } else if (!authCtx.isAdmin) {
      const auth = await authOrPassword(c, deps, body.password || '');
      if (auth !== 'ok') return authFail(c, auth);
    }
    const meta = cleanId ? await deps.meta.getChunkUpload(cleanId) : null;
    if (!meta) return c.json({ ok: false, error: '上传任务不存在或已过期' }, 404);
    if (authCtx.user) {
      if (!(await assertFolderInSubtree(deps, meta.folderId, authCtx.user.rootFolderId))) {
        return c.json({ ok: false, error: '无权完成该目录外的上传任务' }, 403);
      }
      const qCheck = await checkUserQuota(deps, authCtx.user, meta.size);
      if (!qCheck.ok) {
        return c.json({ ok: false, error: '已超出账号空间配额' }, 413);
      }
    }
    for (let i = 0; i < meta.total; i++) {
      if (!meta.received.some((r) => r.partNumber === i) || !(await deps.meta.chunkPartExists(cleanId, i))) {
        return c.json({ ok: false, error: `还缺第 ${i + 1} 片` }, 400);
      }
    }
    const id = newId();
    const ext = extOf(meta.name);
    const finalKey = keyOf(id, meta.name);
    const mime = MIME[ext] || 'application/octet-stream';
    const tmpPath = deps.local.tempFilePath(`.tmp-chunk-${id}`);

    let poolDriver = null;
    if (meta.poolId) {
      const resolved = await resolveUploadTarget(deps, meta.poolId, 'r2');
      if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 400);
      poolDriver = resolved.driver;
    }

    try {
      if (meta.r2UploadId) {
        // CF path: parts already uploaded to R2 / external S3 pool via writeChunkPart
        const drv = poolDriver || deps.r2;
        const assembled = await deps.meta.assembleChunks(cleanId, tmpPath, drv);
        if (assembled !== meta.size) throw new Error('assembled size mismatch');
        await drv.rename(meta.storageKey, finalKey);
      } else if (poolDriver) {
        // VPS path uploading to an external S3/R2 pool: stream parts via S3 multipart (zero full-file RAM)
        if (meta.total === 1) {
          const part0 = await deps.meta.readChunkPart(cleanId, 0);
          if (!part0 || part0.length !== meta.size) throw new Error('assembled size mismatch');
          await poolDriver.put(finalKey, part0, mime);
        } else {
          const mpuId = await poolDriver.createMultipartUpload(finalKey, mime);
          const uploadedParts = [];
          try {
            let totalBytes = 0;
            for (let i = 0; i < meta.total; i++) {
              const partBuf = await deps.meta.readChunkPart(cleanId, i);
              if (!partBuf) throw new Error(`missing chunk ${i}`);
              totalBytes += partBuf.length;
              const { etag } = await poolDriver.uploadPart(mpuId, finalKey, i + 1, partBuf);
              uploadedParts.push({ partNumber: i + 1, etag });
            }
            if (totalBytes !== meta.size) throw new Error('assembled size mismatch');
            await poolDriver.completeMultipartUpload(mpuId, finalKey, uploadedParts);
          } catch (err) {
            try { await poolDriver.abortMultipartUpload(mpuId, finalKey); } catch {}
            throw err;
          }
        }
      } else {
        const assembled = await deps.meta.assembleChunks(cleanId, tmpPath);
        if (assembled !== meta.size) throw new Error('assembled size mismatch');
        if (meta.storage === 'r2') {
          if (!deps.r2.enabled) throw new Error('R2 未配置');
          await deps.r2.putFile(finalKey, tmpPath, mime);
          await deps.local.removeTempFile(tmpPath);
        } else {
          await deps.local.importTempFile(tmpPath, finalKey);
        }
      }
    } catch (e) {
      log('chunk assemble failed:', e && e.message);
      await deps.local.removeTempFile(tmpPath);
      return c.json({ ok: false, error: '合并失败：' + (e && e.message) }, 500);
    }
    try { await deps.meta.deleteChunkUpload(cleanId, poolDriver || deps.r2); } catch {}
    const folders = await deps.meta.listFolders();
    const folderId = (typeof meta.folderId === 'string' && meta.folderId && folders.some((fd) => fd.id === meta.folderId))
      ? meta.folderId
      : (authCtx.user ? authCtx.user.rootFolderId : null);
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id, name: meta.name, size: meta.size, ext, kind: kindOf(ext),
      visibility: meta.visibility, storage: meta.storage, storageKey: finalKey, folderId,
      expiresAt: expiresAtOf(meta.expiresHours),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp, uploadGeo,
      width: parseDim(body.width),
      height: parseDim(body.height),
      poolId: meta.poolId || null,
      ownerId: authCtx.user ? authCtx.user.id : null,
    };
    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('meta save failed:', e && e.message);
      return c.json({ ok: false, error: '保存失败' }, 500);
    }
    if (authCtx.user) {
      await recordAudit(deps, c, 'file_upload', meta.name, `${auditUserPrefix(authCtx)}${meta.size} bytes (chunked)`);
    }
    log('uploaded (chunked):', meta.name, (meta.size / 1024 / 1024).toFixed(2) + 'MB', meta.poolId || meta.storage);
    return c.json({ ok: true, file: item });
  });
}
