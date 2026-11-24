// RelayBox core routes — multi-storage pools (v3.2).
// Manages dynamic external R2 / S3-compatible buckets alongside built-in R2 and
// (on VPS) built-in local disk. Pool secrets are AES-GCM encrypted at rest.

import { readJsonBody, newId, isExpired, R2_FREE_BYTES, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import { encryptSecret, decryptSecret, maskAccessKey } from '../lib/crypto.js';
import { S3PoolStorage } from '../lib/s3-pool.js';
import { getTransferModeState, SETTING_R2_TRANSFER_MODE } from './settings.js';

export const BUILTIN_R2_ID = 'builtin-r2';
export const BUILTIN_LOCAL_ID = 'builtin-local';

/** True only on VPS (Node) where a real local disk exists; false on CF Workers. */
export function hasLocalDisk(deps) {
  return !!(deps.parseMultipart && deps.local && deps.local !== deps.r2);
}

function validateEndpoint(ep) {
  const s = String(ep || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return s;
  } catch {
    return '';
  }
}

export async function buildS3DriverFromPool(deps, pool) {
  const secretAccessKey = await decryptSecret(pool.secretKeyEnc, deps.config.uploadPassword);
  return new S3PoolStorage({
    id: pool.id,
    name: pool.name,
    endpoint: pool.endpoint,
    bucket: pool.bucket,
    region: pool.region,
    accessKeyId: pool.accessKeyId,
    secretAccessKey,
    publicDomain: pool.publicDomain,
    transferMode: pool.transferMode,
    quotaBytes: pool.quotaBytes,
  });
}

/**
 * Resolve the StorageStore driver & transfer mode for an existing file record.
 * - item.poolId set -> dynamic external S3/R2 pool from DB.
 * - item.storage === 'r2' -> built-in deps.r2.
 * - otherwise -> built-in deps.local (VPS disk).
 */
export async function resolveStorageForFile(deps, item) {
  if (item && item.poolId) {
    const pool = await deps.meta.getStoragePool(item.poolId);
    if (!pool) return { ok: false, error: '该文件所属存储池已被删除或不存在', status: 503 };
    const driver = await buildS3DriverFromPool(deps, pool);
    return { ok: true, driver, mode: pool.transferMode, pool, storageType: 'r2', poolId: pool.id };
  }
  if (item && item.storage === 'r2') {
    if (!deps.r2 || !deps.r2.enabled) {
      return { ok: false, error: 'R2 未配置，文件暂时无法访问', status: 503 };
    }
    const transfer = await getTransferModeState(deps);
    return { ok: true, driver: deps.r2, mode: transfer.mode, pool: null, storageType: 'r2', poolId: null };
  }
  return { ok: true, driver: deps.local, mode: 'local', pool: null, storageType: 'local', poolId: null };
}

/**
 * Resolve upload target pool from optional poolId (and legacy storage param).
 * When poolId is empty/omitted, behaves identically to v3.1.6 (built-in R2 or local)
 * so existing clients and API tests stay 100% compatible.
 */
export async function resolveUploadTarget(deps, requestedPoolId, legacyStorage) {
  const pid = (typeof requestedPoolId === 'string') ? requestedPoolId.trim() : '';
  if (pid && pid !== BUILTIN_R2_ID && pid !== BUILTIN_LOCAL_ID) {
    const pool = await deps.meta.getStoragePool(pid);
    if (!pool) return { ok: false, error: '目标存储池不存在', status: 400 };
    if (!pool.enabled) return { ok: false, error: '目标存储池已禁用', status: 400 };
    const driver = await buildS3DriverFromPool(deps, pool);
    return { ok: true, storage: 'r2', poolId: pool.id, driver, transferMode: pool.transferMode, pool };
  }
  if (pid === BUILTIN_LOCAL_ID || (!pid && legacyStorage === 'local')) {
    if (!hasLocalDisk(deps)) {
      return { ok: false, error: '当前部署环境没有本地磁盘，请选择 R2 或外部存储池', status: 400 };
    }
    return { ok: true, storage: 'local', poolId: null, driver: deps.local, transferMode: 'local', pool: null };
  }
  if (!deps.r2 || !deps.r2.enabled) {
    return { ok: false, error: 'R2 未配置', status: 501 };
  }
  const transfer = await getTransferModeState(deps);
  return { ok: true, storage: 'r2', poolId: null, driver: deps.r2, transferMode: transfer.mode, pool: null };
}

/**
 * Build safe pool summaries for /api/files and /api/pools (never exposes secrets).
 */
export async function buildPoolSummaries(deps, allFiles, { authed, includeAdminMeta = false } = {}) {
  const localAvailable = hasLocalDisk(deps);
  const transfer = await getTransferModeState(deps);
  const customPools = (typeof deps.meta.listStoragePools === 'function')
    ? await deps.meta.listStoragePools()
    : [];
  const activeFiles = (allFiles || []).filter((f) => !isExpired(f));
  const chunkSize = deps.config.chunkSize || 5 * 1024 * 1024;
  const presignThreshold = deps.config.chunkUploadThreshold || 32 * 1024 * 1024;
  const proxyThreshold = deps.config.proxyChunkUploadThreshold || Math.min(presignThreshold, chunkSize);

  const customDefault = customPools.find((p) => p.enabled && p.isDefault);
  const list = [];

  if (deps.r2 && deps.r2.enabled) {
    const usedBytes = activeFiles
      .filter((f) => f.storage === 'r2' && !f.poolId)
      .reduce((a, f) => a + (f.size || 0), 0);
    list.push({
      id: BUILTIN_R2_ID,
      name: '内置 R2',
      type: 'r2-binding',
      builtin: true,
      enabled: true,
      isDefault: !customDefault,
      transferMode: transfer.mode,
      presignAvailable: transfer.presignAvailable,
      proxyAvailable: transfer.proxyAvailable,
      chunkUploadThreshold: transfer.mode === 'proxy' ? proxyThreshold : presignThreshold,
      chunkSize,
      ...(authed ? { usedBytes, quotaBytes: R2_FREE_BYTES } : {}),
    });
  }

  if (localAvailable) {
    const usedBytes = activeFiles
      .filter((f) => f.storage !== 'r2' && !f.poolId)
      .reduce((a, f) => a + (f.size || 0), 0);
    const diskTotal = deps.local.totalBytes();
    list.push({
      id: BUILTIN_LOCAL_ID,
      name: '本地磁盘',
      type: 'local',
      builtin: true,
      enabled: true,
      isDefault: !customDefault && !(deps.r2 && deps.r2.enabled),
      transferMode: 'local',
      presignAvailable: false,
      proxyAvailable: false,
      chunkUploadThreshold: presignThreshold,
      chunkSize,
      ...(authed ? { usedBytes, quotaBytes: diskTotal } : {}),
    });
  }

  for (const p of customPools) {
    if (!includeAdminMeta && !p.enabled) continue;
    const usedBytes = activeFiles
      .filter((f) => f.poolId === p.id)
      .reduce((a, f) => a + (f.size || 0), 0);
    const fileCount = activeFiles.filter((f) => f.poolId === p.id).length;
    const entry = {
      id: p.id,
      name: p.name,
      type: p.type || 's3',
      builtin: false,
      enabled: p.enabled,
      isDefault: !!(customDefault && customDefault.id === p.id),
      transferMode: p.transferMode,
      presignAvailable: true,
      proxyAvailable: true,
      chunkUploadThreshold: p.transferMode === 'proxy' ? proxyThreshold : presignThreshold,
      chunkSize,
      ...(authed ? { usedBytes, quotaBytes: p.quotaBytes, fileCount } : {}),
    };
    if (includeAdminMeta) {
      entry.endpoint = p.endpoint;
      entry.bucket = p.bucket;
      entry.region = p.region;
      entry.accessKeyPreview = maskAccessKey(p.accessKeyId);
      entry.accessKeyId = p.accessKeyId;
      entry.hasSecret = !!p.secretKeyEnc;
      entry.publicDomain = p.publicDomain || '';
      entry.sortOrder = p.sortOrder;
      entry.createdAt = p.createdAt;
    }
    list.push(entry);
  }

  const defPool = list.find((x) => x.isDefault && x.enabled) || list.find((x) => x.enabled) || list[0] || null;
  return {
    pools: list,
    defaultPoolId: defPool ? defPool.id : BUILTIN_R2_ID,
    poolNameMap: new Map(list.map((p) => [p.id, p.name])),
  };
}

export function registerPools(app) {
  app.get('/api/pools', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const summary = await buildPoolSummaries(deps, allFiles, { authed: true, includeAdminMeta: true });
    return c.json({ ok: true, pools: summary.pools, defaultPoolId: summary.defaultPoolId });
  });

  app.post('/api/pools', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const name = String(body.name || '').trim().slice(0, 40);
    const endpoint = validateEndpoint(body.endpoint);
    const bucket = String(body.bucket || '').trim().slice(0, 100);
    const region = String(body.region || 'auto').trim().slice(0, 40) || 'auto';
    const accessKeyId = String(body.accessKeyId || '').trim().slice(0, 128);
    const secretAccessKey = String(body.secretAccessKey || '').trim().slice(0, 256);
    const publicDomain = body.publicDomain ? validateEndpoint(body.publicDomain) : '';
    const transferMode = body.transferMode === 'proxy' ? 'proxy' : 'presign';
    const quotaBytes = Number(body.quotaBytes) > 0 ? Math.floor(Number(body.quotaBytes)) : R2_FREE_BYTES;
    const enabled = body.enabled !== false;
    const isDefault = body.isDefault === true && enabled;

    if (!name) return c.json({ ok: false, error: '请填写存储池名称' }, 400);
    if (!endpoint) return c.json({ ok: false, error: 'Endpoint 必须是有效的 http(s):// 地址' }, 400);
    if (!bucket) return c.json({ ok: false, error: '请填写存储桶名称（Bucket）' }, 400);
    if (!accessKeyId || !secretAccessKey) return c.json({ ok: false, error: '请填写 Access Key ID 和 Secret Access Key' }, 400);

    const secretKeyEnc = await encryptSecret(secretAccessKey, deps.config.uploadPassword);
    const created = await deps.meta.createStoragePool({
      id: 'pool_' + newId(),
      name,
      type: 's3',
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretKeyEnc,
      publicDomain,
      transferMode,
      quotaBytes,
      enabled,
      isDefault,
      sortOrder: 0,
      createdAt: Date.now(),
    });
    log('storage pool created:', created.name, created.bucket);
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const summary = await buildPoolSummaries(deps, allFiles, { authed: true, includeAdminMeta: true });
    return c.json({ ok: true, id: created.id, pools: summary.pools, defaultPoolId: summary.defaultPoolId });
  });

  app.put('/api/pools/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const body = await readJsonBody(c);

    // 内置 R2 允许通过同一入口修改默认池与传输模式
    if (id === BUILTIN_R2_ID) {
      if (body.transferMode === 'presign' || body.transferMode === 'proxy') {
        const state = await getTransferModeState(deps);
        if (body.transferMode === 'presign' && !state.presignAvailable) {
          return c.json({ ok: false, error: '内置 R2 未配置 S3 密钥，无法切换为预签名直传' }, 400);
        }
        if (body.transferMode === 'proxy' && !state.proxyAvailable) {
          return c.json({ ok: false, error: '当前部署环境不支持中转模式' }, 400);
        }
        await deps.meta.setSetting(SETTING_R2_TRANSFER_MODE, body.transferMode);
      }
      if (body.isDefault === true) {
        const pools = await deps.meta.listStoragePools();
        for (const p of pools) {
          if (p.isDefault) await deps.meta.updateStoragePool(p.id, { isDefault: false });
        }
      }
      const allFiles = await deps.meta.listAllFiles({ authed: true });
      const summary = await buildPoolSummaries(deps, allFiles, { authed: true, includeAdminMeta: true });
      return c.json({ ok: true, pools: summary.pools, defaultPoolId: summary.defaultPoolId });
    }

    const existing = await deps.meta.getStoragePool(id);
    if (!existing) return c.json({ ok: false, error: '存储池不存在' }, 404);

    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return c.json({ ok: false, error: '存储池名称不能为空' }, 400);
      patch.name = name;
    }
    if (body.endpoint !== undefined) {
      const ep = validateEndpoint(body.endpoint);
      if (!ep) return c.json({ ok: false, error: 'Endpoint 格式不对' }, 400);
      patch.endpoint = ep;
    }
    if (body.bucket !== undefined) {
      const b = String(body.bucket || '').trim().slice(0, 100);
      if (!b) return c.json({ ok: false, error: 'Bucket 不能为空' }, 400);
      patch.bucket = b;
    }
    if (body.region !== undefined) {
      patch.region = String(body.region || 'auto').trim().slice(0, 40) || 'auto';
    }
    if (body.accessKeyId !== undefined) {
      const ak = String(body.accessKeyId || '').trim().slice(0, 128);
      if (!ak) return c.json({ ok: false, error: 'Access Key ID 不能为空' }, 400);
      patch.accessKeyId = ak;
    }
    if (typeof body.secretAccessKey === 'string' && body.secretAccessKey.trim()) {
      patch.secretKeyEnc = await encryptSecret(body.secretAccessKey.trim().slice(0, 256), deps.config.uploadPassword);
    }
    if (body.publicDomain !== undefined) {
      patch.publicDomain = body.publicDomain ? validateEndpoint(body.publicDomain) : '';
    }
    if (body.transferMode !== undefined) {
      patch.transferMode = body.transferMode === 'proxy' ? 'proxy' : 'presign';
    }
    if (body.quotaBytes !== undefined) {
      const q = Number(body.quotaBytes);
      if (Number.isFinite(q) && q > 0) patch.quotaBytes = Math.floor(q);
    }
    if (body.enabled !== undefined) {
      patch.enabled = !!body.enabled;
      if (!patch.enabled) patch.isDefault = false;
    }
    if (body.isDefault !== undefined) {
      patch.isDefault = body.isDefault === true && (patch.enabled !== undefined ? patch.enabled : existing.enabled);
    }

    await deps.meta.updateStoragePool(id, patch);
    log('storage pool updated:', id);
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const summary = await buildPoolSummaries(deps, allFiles, { authed: true, includeAdminMeta: true });
    return c.json({ ok: true, pools: summary.pools, defaultPoolId: summary.defaultPoolId });
  });

  app.delete('/api/pools/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    if (id === BUILTIN_R2_ID || id === BUILTIN_LOCAL_ID) {
      return c.json({ ok: false, error: '内置存储池不能删除' }, 400);
    }
    const existing = await deps.meta.getStoragePool(id);
    if (!existing) return c.json({ ok: false, error: '存储池不存在' }, 404);
    const allFiles = await deps.meta.listAllFiles({ authed: true });
    const count = allFiles.filter((f) => !isExpired(f) && f.poolId === id).length;
    if (count > 0) {
      return c.json({ ok: false, error: `该存储池还有 ${count} 个文件，请先删除文件后再移除存储池` }, 400);
    }
    await deps.meta.deleteStoragePool(id);
    log('storage pool deleted:', id);
    const summary = await buildPoolSummaries(deps, allFiles, { authed: true, includeAdminMeta: true });
    return c.json({ ok: true, pools: summary.pools, defaultPoolId: summary.defaultPoolId });
  });

  app.post('/api/pools/test', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    let endpoint = validateEndpoint(body.endpoint);
    let bucket = String(body.bucket || '').trim();
    let region = String(body.region || 'auto').trim() || 'auto';
    let accessKeyId = String(body.accessKeyId || '').trim();
    let secretAccessKey = String(body.secretAccessKey || '').trim();

    if (body.id) {
      const saved = await deps.meta.getStoragePool(String(body.id));
      if (!saved) return c.json({ ok: false, error: '存储池不存在' }, 404);
      if (!endpoint) endpoint = saved.endpoint;
      if (!bucket) bucket = saved.bucket;
      if (!body.region) region = saved.region;
      if (!accessKeyId) accessKeyId = saved.accessKeyId;
      if (!secretAccessKey) {
        secretAccessKey = await decryptSecret(saved.secretKeyEnc, deps.config.uploadPassword);
      }
    }

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      return c.json({ ok: false, error: '请补全 Endpoint、Bucket、AK 与 SK 后再测试' }, 400);
    }
    try {
      const driver = new S3PoolStorage({ endpoint, bucket, region, accessKeyId, secretAccessKey });
      const result = await driver.testConnection();
      if (result.ok) return c.json({ ok: true, latencyMs: result.latencyMs });
      return c.json({ ok: false, error: '连接失败：' + (result.error || '未知错误'), latencyMs: result.latencyMs }, 400);
    } catch (e) {
      return c.json({ ok: false, error: '连接失败：' + ((e && e.message) || '网络异常') }, 400);
    }
  });
}
