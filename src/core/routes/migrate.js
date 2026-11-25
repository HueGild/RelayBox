// RelayBox core routes — Cross-Pool One-Click File Migration (v3.3.7, Station 8).
// Pure Web APIs (ReadableStream / fetch). Zero Node built-in deps.
// Safely migrates files between built-in R2, local disk (VPS), and external S3/R2 pools:
//   write to target (streaming multipart for larger files) -> HEAD verify ->
//   update metadata (keeping id / links / shares / thumbnails intact) -> delete source.
// Covers:
//   GET  /api/pools/:id/files   — list active files in a pool (admin, drives UI progress)
//   POST /api/files/:id/migrate — migrate a single file to targetPoolId (admin)
//   POST /api/pools/migrate     — batch migrate by fileIds[] or sourcePoolId (admin)

import { readJsonBody, isExpired, keyOf, MIN_FREE_BYTES, MIME, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import {
  resolveStorageForFile, resolveUploadTarget, buildPoolSummaries,
  BUILTIN_R2_ID, BUILTIN_LOCAL_ID,
} from './pools.js';

const DEFAULT_MAX_MIGRATE_BYTES = 100 * 1024 * 1024; // 100MB per-file online migration cap
const DEFAULT_MULTIPART_THRESHOLD = 10 * 1024 * 1024; // >10MB streams via 5MB S3/R2 multipart parts
const DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5MB S3 minimum part size
const MAX_BATCH_FILES = 50;

export function poolIdOfItem(item) {
  if (!item) return BUILTIN_R2_ID;
  if (item.poolId) return item.poolId;
  return item.storage === 'r2' ? BUILTIN_R2_ID : BUILTIN_LOCAL_ID;
}

function poolIdOfTarget(target) {
  if (target.poolId) return target.poolId;
  return target.storage === 'r2' ? BUILTIN_R2_ID : BUILTIN_LOCAL_ID;
}

function poolNameOfTarget(target) {
  if (target.pool && target.pool.name) return target.pool.name;
  return target.storage === 'local' ? '本地磁盘' : '内置 R2';
}

function maxMigrateBytesOf(deps) {
  const cfg = Number(deps && deps.config && deps.config.migrateMaxBytes);
  return (Number.isFinite(cfg) && cfg > 0) ? Math.floor(cfg) : DEFAULT_MAX_MIGRATE_BYTES;
}

function multipartThresholdOf(deps) {
  const cfg = Number(deps && deps.config && deps.config.migrateMultipartThreshold);
  return (Number.isFinite(cfg) && cfg > 0) ? Math.floor(cfg) : DEFAULT_MULTIPART_THRESHOLD;
}

function partSizeOf(deps) {
  const cfg = Number(deps && deps.config && deps.config.migratePartSize);
  return (Number.isFinite(cfg) && cfg > 0) ? Math.floor(cfg) : DEFAULT_PART_SIZE;
}

async function openSourceStream(srcDriver, storageKey, fetchFn) {
  let res = await srcDriver.get(storageKey, { mode: 'proxy' });
  if (!res) return { ok: false, status: 404, error: '源存储池中找不到该文件实体' };
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || res.headers.get('Location');
    if (!loc) return { ok: false, status: 502, error: '无法获取源文件下载地址' };
    res = await fetchFn(loc);
  }
  if (res.status === 404) return { ok: false, status: 404, error: '源存储池中找不到该文件实体' };
  if (!res.ok) return { ok: false, status: 502, error: `读取源文件失败（HTTP ${res.status}）` };
  return { ok: true, res };
}

async function readAllBytesWithLimit(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, bytes: new Uint8Array(ab) };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch (e) {
    try { await reader.cancel(); } catch {}
    throw e;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return { ok: true, bytes: out };
}

async function writeBytesToTarget(driver, key, bytes, mime, fetchFn) {
  try {
    await driver.put(key, bytes, mime);
  } catch (e) {
    if (e && e.code === 'R2_BINDING_MISSING' && driver.presignEnabled && typeof driver.presignedPutUrl === 'function') {
      const putUrl = await driver.presignedPutUrl(key, { contentLength: bytes.byteLength, expiresIn: 300 });
      const putRes = await fetchFn(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: bytes,
      });
      if (!putRes.ok) throw new Error(`presign PUT HTTP ${putRes.status}`);
      return;
    }
    throw e;
  }
}

/** Stream from a ReadableStream into a multipart-capable target driver in fixed-size parts (low peak RAM). */
async function streamToMultipartTarget(res, targetDriver, key, mime, maxBytes, partSize) {
  const reader = res.body.getReader();
  const uploadId = await targetDriver.createMultipartUpload(key, mime);
  const parts = [];
  let partNumber = 1;
  let totalBytes = 0;
  let pending = [];
  let pendingLen = 0;

  async function flushBuffer(chunkBytes) {
    const { etag } = await targetDriver.uploadPart(uploadId, key, partNumber, chunkBytes);
    parts.push({ partNumber, etag });
    partNumber++;
  }

  function concatPending(takeLen) {
    const out = new Uint8Array(takeLen);
    let offset = 0;
    while (offset < takeLen && pending.length) {
      const head = pending[0];
      const need = takeLen - offset;
      if (head.byteLength <= need) {
        out.set(head, offset);
        offset += head.byteLength;
        pending.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        pending[0] = head.subarray(need);
        offset += need;
      }
    }
    pendingLen -= takeLen;
    return out;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch {}
        const err = new Error('MIGRATE_TOO_LARGE');
        err.code = 'MIGRATE_TOO_LARGE';
        throw err;
      }
      pending.push(value);
      pendingLen += value.byteLength;
      while (pendingLen >= partSize) {
        const partBuf = concatPending(partSize);
        await flushBuffer(partBuf);
      }
    }
    if (pendingLen > 0) {
      const lastBuf = concatPending(pendingLen);
      await flushBuffer(lastBuf);
    }
    if (!parts.length) {
      await targetDriver.abortMultipartUpload(uploadId, key);
      await targetDriver.put(key, new Uint8Array(0), mime);
      return 0;
    }
    await targetDriver.completeMultipartUpload(uploadId, key, parts);
    return totalBytes;
  } catch (e) {
    try { await reader.cancel(); } catch {}
    try { await targetDriver.abortMultipartUpload(uploadId, key); } catch {}
    throw e;
  }
}

/**
 * Migrate one file record to a resolved target pool.
 * Safe order: write target -> verify target HEAD -> update metadata -> delete source.
 */
export async function migrateSingleFile(deps, item, target, { deleteSource = true } = {}) {
  const fromPoolId = poolIdOfItem(item);
  const toPoolId = poolIdOfTarget(target);
  const toPoolName = poolNameOfTarget(target);

  if (fromPoolId === toPoolId) {
    return {
      ok: true,
      migrated: false,
      skipped: true,
      reason: '文件已在目标存储池中',
      fromPoolId,
      toPoolId,
      toPoolName,
      file: item,
    };
  }

  const maxBytes = maxMigrateBytesOf(deps);
  if (item.size > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `单文件超过在线迁移上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）`,
    };
  }

  if (target.storage === 'local' && deps.local.freeBytes() < MIN_FREE_BYTES) {
    return { ok: false, status: 507, error: '本地磁盘空间不足' };
  }

  const src = await resolveStorageForFile(deps, item);
  if (!src.ok) return { ok: false, status: src.status || 503, error: src.error };

  const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
  const opened = await openSourceStream(src.driver, item.storageKey, fetchFn);
  if (!opened.ok) return { ok: false, status: opened.status || 502, error: opened.error };
  const srcRes = opened.res;

  const cl = Number(srcRes.headers.get('content-length') || 0);
  if (Number.isFinite(cl) && cl > maxBytes) {
    try { if (srcRes.body && typeof srcRes.body.cancel === 'function') await srcRes.body.cancel(); } catch {}
    return {
      ok: false,
      status: 413,
      error: `单文件超过在线迁移上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）`,
    };
  }

  const newKey = item.storageKey || keyOf(item.id, item.name);
  const mime = MIME[item.ext] || srcRes.headers.get('content-type') || 'application/octet-stream';
  const mpThreshold = multipartThresholdOf(deps);
  const partSize = partSizeOf(deps);
  const canMultipart = target.storage === 'r2'
    && srcRes.body && typeof srcRes.body.getReader === 'function'
    && typeof target.driver.createMultipartUpload === 'function'
    && typeof target.driver.uploadPart === 'function'
    && typeof target.driver.completeMultipartUpload === 'function'
    && typeof target.driver.abortMultipartUpload === 'function';

  let writtenBytes = 0;
  try {
    if (canMultipart && item.size > mpThreshold) {
      writtenBytes = await streamToMultipartTarget(srcRes, target.driver, newKey, mime, maxBytes, partSize);
    } else {
      const read = await readAllBytesWithLimit(srcRes, maxBytes);
      if (!read.ok && read.tooLarge) {
        return {
          ok: false,
          status: 413,
          error: `单文件超过在线迁移上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）`,
        };
      }
      writtenBytes = read.bytes.byteLength;
      await writeBytesToTarget(target.driver, newKey, read.bytes, mime, fetchFn);
    }
  } catch (e) {
    if (e && e.code === 'MIGRATE_TOO_LARGE') {
      return {
        ok: false,
        status: 413,
        error: `单文件超过在线迁移上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）`,
      };
    }
    log('migrate write target failed:', item.name, e && e.message);
    try { await target.driver.delete(newKey); } catch {}
    return { ok: false, status: 500, error: '写入目标存储池失败：' + ((e && e.message) || '未知错误') };
  }

  // Verify object exists in target pool before flipping metadata
  try {
    const head = await target.driver.head(newKey);
    if (!head || (writtenBytes > 0 && Number.isFinite(head.size) && head.size !== writtenBytes)) {
      try { await target.driver.delete(newKey); } catch {}
      return { ok: false, status: 500, error: '目标存储池校验失败，已保留原文件未变动' };
    }
  } catch (e) {
    log('migrate head verify failed:', item.name, e && e.message);
    try { await target.driver.delete(newKey); } catch {}
    return { ok: false, status: 500, error: '目标存储池校验失败，已保留原文件未变动' };
  }

  // Update metadata (keeping file id, shares, pickup code, folderId, thumbnails intact)
  let updated;
  try {
    const patch = {
      storage: target.storage,
      poolId: target.poolId || null,
      storageKey: newKey,
    };
    if (writtenBytes !== item.size && writtenBytes > 0) patch.size = writtenBytes;
    updated = await deps.meta.updateFile(item.id, patch);
  } catch (e) {
    log('migrate meta update failed, rolling back target:', item.name, e && e.message);
    try { await target.driver.delete(newKey); } catch {}
    return { ok: false, status: 500, error: '更新文件元数据失败，已回滚' };
  }

  let sourceDeleted = false;
  if (deleteSource) {
    try {
      await src.driver.delete(item.storageKey);
      sourceDeleted = true;
    } catch (e) {
      log('migrate source cleanup warning:', item.name, e && e.message);
    }
  }

  log('migrated:', item.name, fromPoolId, '->', toPoolId, `(${writtenBytes}B)`);
  return {
    ok: true,
    migrated: true,
    skipped: false,
    sourceDeleted,
    fromPoolId,
    toPoolId,
    toPoolName,
    bytes: writtenBytes,
    file: updated || { ...item, storage: target.storage, poolId: target.poolId || null, storageKey: newKey },
  };
}

export function registerMigrate(app) {
  // 列出指定存储池下的文件清单（供整池一键迁移进度条使用，仅管理员）
  app.get('/api/pools/:id/files', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const poolId = decodeURIComponent(c.req.param('id'));
    const includeTrashed = c.req.query('includeTrashed') === '1';
    const allFiles = await deps.meta.listAllFiles({ authed: true, includeTrashed });
    const matched = allFiles
      .filter((f) => !isExpired(f) && (includeTrashed || !f.deletedAt) && poolIdOfItem(f) === poolId)
      .map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size || 0,
        storage: f.storage,
        poolId: f.poolId || null,
        deletedAt: f.deletedAt || null,
      }));
    const totalBytes = matched.reduce((a, f) => a + f.size, 0);
    return c.json({ ok: true, poolId, files: matched, total: matched.length, totalBytes });
  });

  // 单文件跨池迁移（仅管理员）
  app.post('/api/files/:id/migrate', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);
    const targetPoolId = typeof body.targetPoolId === 'string' ? body.targetPoolId.trim() : '';
    if (!targetPoolId) return c.json({ ok: false, error: '请选择目标存储池' }, 400);

    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (isExpired(item)) return c.json({ ok: false, error: '文件已过期' }, 404);

    const target = await resolveUploadTarget(deps, targetPoolId);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 400);

    const res = await migrateSingleFile(deps, item, target, {
      deleteSource: body.deleteSource !== false,
    });
    if (!res.ok) return c.json({ ok: false, error: res.error }, res.status || 500);
    return c.json(res);
  });

  // 批量 / 整池迁移（仅管理员）
  app.post('/api/pools/migrate', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const targetPoolId = typeof body.targetPoolId === 'string' ? body.targetPoolId.trim() : '';
    if (!targetPoolId) return c.json({ ok: false, error: '请选择目标存储池' }, 400);

    const target = await resolveUploadTarget(deps, targetPoolId);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 400);

    const deleteSource = body.deleteSource !== false;
    const includeTrashed = body.includeTrashed === true;
    const limitRaw = Number(body.limit);
    const limit = (Number.isFinite(limitRaw) && limitRaw > 0)
      ? Math.min(MAX_BATCH_FILES, Math.floor(limitRaw))
      : 20;

    let candidates = [];
    let remaining = 0;

    if (Array.isArray(body.fileIds) && body.fileIds.length) {
      const uniq = [...new Set(body.fileIds.map(String))];
      const slice = uniq.slice(0, MAX_BATCH_FILES);
      remaining = Math.max(0, uniq.length - slice.length);
      for (const fid of slice) {
        const f = await deps.meta.getFile(fid);
        if (f && !isExpired(f) && (includeTrashed || !f.deletedAt)) {
          candidates.push(f);
        } else {
          candidates.push({ _missingId: fid });
        }
      }
    } else if (typeof body.sourcePoolId === 'string' && body.sourcePoolId.trim()) {
      const sourcePoolId = body.sourcePoolId.trim();
      if (sourcePoolId === poolIdOfTarget(target)) {
        return c.json({ ok: false, error: '源存储池和目标存储池不能相同' }, 400);
      }
      const allFiles = await deps.meta.listAllFiles({ authed: true, includeTrashed });
      const matching = allFiles.filter(
        (f) => !isExpired(f) && (includeTrashed || !f.deletedAt) && poolIdOfItem(f) === sourcePoolId,
      );
      candidates = matching.slice(0, limit);
      remaining = Math.max(0, matching.length - candidates.length);
    } else {
      return c.json({ ok: false, error: '请指定要迁移的文件列表（fileIds）或源存储池（sourcePoolId）' }, 400);
    }

    let migrated = 0;
    let skipped = 0;
    let failed = 0;
    let migratedBytes = 0;
    const results = [];

    for (const item of candidates) {
      if (item._missingId) {
        failed++;
        results.push({ id: item._missingId, ok: false, error: '文件不存在或已过期' });
        continue;
      }
      const r = await migrateSingleFile(deps, item, target, { deleteSource });
      if (r.ok && r.skipped) {
        skipped++;
        results.push({ id: item.id, name: item.name, ok: true, skipped: true });
      } else if (r.ok) {
        migrated++;
        migratedBytes += (r.bytes || item.size || 0);
        results.push({ id: item.id, name: item.name, ok: true, skipped: false, sourceDeleted: r.sourceDeleted });
      } else {
        failed++;
        results.push({ id: item.id, name: item.name, ok: false, error: r.error });
      }
    }

    const allAfter = await deps.meta.listAllFiles({ authed: true, includeTrashed: true });
    const summary = await buildPoolSummaries(deps, allAfter, { authed: true, includeAdminMeta: false });
    return c.json({
      ok: true,
      targetPoolId: poolIdOfTarget(target),
      targetPoolName: poolNameOfTarget(target),
      migrated,
      skipped,
      failed,
      migratedBytes,
      remaining,
      results,
      pools: summary.pools,
    });
  });
}
