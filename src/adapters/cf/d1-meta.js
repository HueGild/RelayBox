// RelayBox Cloudflare adapter — D1MetaStore (Workers target).
// Implements the MetaStore contract on D1 (SQLite) + the chunk-part bytes
// via the R2 multipart API (through the injected R2Storage).

import { FAIL_WINDOW_MS, FAIL_LIMIT, CHUNK_SIZE, MIME, extOf, parseDim } from '../../core/lib/util.js';

const CHUNK_TMP_PREFIX = 'chunks/';

/** ISO string -> ms (null stays null). */
function isoToMs(v) {
  if (v === null || v === undefined) return null;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
}
/** ms -> ISO string (null stays null). */
function msToIso(v) {
  if (v === null || v === undefined) return null;
  return new Date(v).toISOString();
}

export class D1MetaStore {
  constructor(db, r2storage) {
    if (!db) throw new Error('D1MetaStore requires a D1 database binding');
    this.db = db;
    this.r2 = r2storage || null;
  }

  // ---- row mapping ----
  _rowToFile(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      size: r.size,
      ext: r.ext || '',
      kind: r.kind || 'file',
      storage: r.storage === 'r2' ? 'r2' : 'local',
      storageKey: r.storage_key || `${r.id}_${r.name}`,
      folderId: (typeof r.folder_id === 'string' && r.folder_id) ? r.folder_id : null,
      visibility: r.visibility === 'private' ? 'private' : 'public',
      expiresAt: msToIso(r.expires_at),
      downloads: typeof r.downloads === 'number' ? r.downloads : 0,
      uploadedAt: msToIso(r.uploaded_at),
      uploadIp: (typeof r.upload_ip === 'string' && r.upload_ip) ? r.upload_ip : null,
      uploadGeo: (typeof r.upload_geo === 'string' && r.upload_geo) ? r.upload_geo : null,
      width: parseDim(r.width),
      height: parseDim(r.height),
      poolId: (typeof r.pool_id === 'string' && r.pool_id) ? r.pool_id : null,
    };
  }
  _rowToFolder(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      parentId: (typeof r.parent_id === 'string' && r.parent_id) ? r.parent_id : null,
      createdAt: msToIso(r.created_at),
    };
  }
  _rowToShare(r) {
    if (!r) return null;
    return {
      token: r.token,
      fileId: r.file_id || null,
      folderId: r.folder_id || null,
      code: typeof r.code === 'string' ? r.code : '',
      burn: r.burn === 1,
      maxDownloads: typeof r.max_downloads === 'number' ? r.max_downloads : 0,
      usedDownloads: typeof r.used_downloads === 'number' ? r.used_downloads : 0,
      pickupCode: (typeof r.pickup_code === 'string' && r.pickup_code) ? r.pickup_code : null,
      createdAt: msToIso(r.created_at),
    };
  }
  _rowToChunk(r) {
    if (!r) return null;
    let received = [];
    try {
      const v = JSON.parse(r.received || '[]');
      if (Array.isArray(v)) received = v;
    } catch { received = []; }
    received = received
      .map((x) => (typeof x === 'number' ? { partNumber: x, etag: null } : x))
      .filter((x) => x && Number.isInteger(x.partNumber))
      .sort((a, b) => a.partNumber - b.partNumber);
    return {
      uploadId: r.upload_id,
      r2UploadId: r.r2_upload_id || null,
      storageKey: r.storage_key || null,
      name: r.name,
      size: r.size,
      total: r.total,
      received,
      storage: r.storage === 'r2' ? 'r2' : 'local',
      folderId: (typeof r.folder_id === 'string' && r.folder_id) ? r.folder_id : null,
      visibility: r.visibility === 'private' ? 'private' : 'public',
      expiresHours: typeof r.expires_hours === 'number' ? r.expires_hours : 0,
      createdAt: r.created_at,
      chunkSize: CHUNK_SIZE,
      poolId: (typeof r.pool_id === 'string' && r.pool_id) ? r.pool_id : null,
    };
  }

  // ---- files ----
  async getFile(id) {
    const r = await this.db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
    return this._rowToFile(r);
  }

  async listFiles(folderId, { authed } = {}) {
    const now = Date.now();
    const { results } = await this.db.prepare(
      'SELECT * FROM files WHERE folder_id IS ? AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?)',
    ).bind(folderId || null, now, authed ? 1 : 0, 'public').all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async listAllFiles({ authed } = {}) {
    const { results } = await this.db.prepare(
      'SELECT * FROM files WHERE (? OR visibility = ?)',
    ).bind(authed ? 1 : 0, 'public').all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async searchFiles(q, { authed } = {}) {
    const needle = String(q || '').toLowerCase();
    if (!needle) return [];
    const now = Date.now();
    const esc = needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { results } = await this.db.prepare(
      "SELECT * FROM files WHERE lower(name) LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?)",
    ).bind(`%${esc}%`, now, authed ? 1 : 0, 'public').all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async createFile(file) {
    const item = this._rowToFile({
      id: file.id, name: file.name, size: file.size, ext: file.ext || '',
      kind: file.kind || 'file', storage: file.storage, storage_key: file.storageKey,
      folder_id: file.folderId, visibility: file.visibility,
      expires_at: isoToMs(file.expiresAt), downloads: file.downloads || 0,
      uploaded_at: isoToMs(file.uploadedAt),
      upload_ip: file.uploadIp || null,
      upload_geo: file.uploadGeo || null,
      width: parseDim(file.width),
      height: parseDim(file.height),
      pool_id: (typeof file.poolId === 'string' && file.poolId) ? file.poolId : null,
    });
    await this.db.prepare(
      'INSERT INTO files (id, name, size, ext, kind, storage, storage_key, folder_id, visibility, expires_at, downloads, uploaded_at, upload_ip, upload_geo, width, height, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.id, item.name, item.size, item.ext, item.kind, item.storage, item.storageKey,
      item.folderId, item.visibility, isoToMs(item.expiresAt), item.downloads, isoToMs(item.uploadedAt),
      item.uploadIp, item.uploadGeo, item.width, item.height, item.poolId,
    ).run();
    return item;
  }

  async updateFile(id, patch) {
    const cur = await this.getFile(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const row = {
      id: next.id, name: next.name, size: next.size, ext: next.ext || '',
      kind: next.kind || 'file', storage: next.storage, storage_key: next.storageKey,
      folder_id: next.folderId, visibility: next.visibility,
      expires_at: isoToMs(next.expiresAt), downloads: next.downloads || 0,
      uploaded_at: isoToMs(next.uploadedAt),
      upload_ip: (typeof next.uploadIp === 'string' && next.uploadIp) ? next.uploadIp : null,
      upload_geo: (typeof next.uploadGeo === 'string' && next.uploadGeo) ? next.uploadGeo : null,
      width: parseDim(next.width),
      height: parseDim(next.height),
      pool_id: (typeof next.poolId === 'string' && next.poolId) ? next.poolId : null,
    };
    await this.db.prepare(
      'UPDATE files SET name = ?, size = ?, ext = ?, kind = ?, storage = ?, storage_key = ?, folder_id = ?, visibility = ?, expires_at = ?, downloads = ?, uploaded_at = ?, upload_ip = ?, upload_geo = ?, width = ?, height = ?, pool_id = ? WHERE id = ?',
    ).bind(
      row.name, row.size, row.ext, row.kind, row.storage, row.storage_key,
      row.folder_id, row.visibility, row.expires_at, row.downloads, row.uploaded_at,
      row.upload_ip, row.upload_geo, row.width, row.height, row.pool_id, id,
    ).run();
    return this._rowToFile(row);
  }

  async deleteFile(id) {
    const out = await this.db.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
    return (out.meta && out.meta.changes > 0) || false;
  }

  async incrementDownloads(id) {
    await this.db.prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
  }

  // ---- folders ----
  async listFolders() {
    const { results } = await this.db.prepare('SELECT * FROM folders').all();
    return (results || []).map((r) => this._rowToFolder(r));
  }

  async getFolder(id) {
    const r = await this.db.prepare('SELECT * FROM folders WHERE id = ?').bind(id).first();
    return this._rowToFolder(r);
  }

  async createFolder(folder) {
    const item = this._rowToFolder({
      id: folder.id, name: folder.name, parent_id: folder.parentId,
      created_at: isoToMs(folder.createdAt),
    });
    await this.db.prepare(
      'INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)',
    ).bind(item.id, item.name, item.parentId, isoToMs(item.createdAt)).run();
    return item;
  }

  async updateFolder(id, patch) {
    const cur = await this.getFolder(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.db.prepare(
      'UPDATE folders SET name = ?, parent_id = ? WHERE id = ?',
    ).bind(next.name, next.parentId || null, id).run();
    return next;
  }

  async deleteFolder(id) {
    const cur = await this.getFolder(id);
    if (!cur) return false;
    const hasFiles = await this.db.prepare('SELECT 1 FROM files WHERE folder_id = ? LIMIT 1').bind(id).first();
    if (hasFiles) return false;
    const hasSubs = await this.db.prepare('SELECT 1 FROM folders WHERE parent_id = ? LIMIT 1').bind(id).first();
    if (hasSubs) return false;
    const out = await this.db.prepare('DELETE FROM folders WHERE id = ?').bind(id).run();
    return (out.meta && out.meta.changes > 0) || false;
  }

  // ---- shares ----
  async getShareByToken(token) {
    const r = await this.db.prepare('SELECT * FROM shares WHERE token = ?').bind(token).first();
    return this._rowToShare(r);
  }
  async getShareByFileId(fileId) {
    const r = await this.db.prepare('SELECT * FROM shares WHERE file_id = ?').bind(fileId).first();
    return this._rowToShare(r);
  }
  async getShareByFolderId(folderId) {
    const r = await this.db.prepare('SELECT * FROM shares WHERE folder_id = ?').bind(folderId).first();
    return this._rowToShare(r);
  }
  async getShareByPickupCode(code) {
    const c = (typeof code === 'string' && code) ? code.trim().toUpperCase() : '';
    if (!c) return null;
    const r = await this.db.prepare('SELECT * FROM shares WHERE pickup_code = ?').bind(c).first();
    return this._rowToShare(r);
  }
  async createShare(share) {
    const item = this._rowToShare({
      token: share.token, file_id: share.fileId || null, folder_id: share.folderId || null,
      code: share.code || '', burn: share.burn ? 1 : 0,
      max_downloads: typeof share.maxDownloads === 'number' ? share.maxDownloads : 0,
      used_downloads: typeof share.usedDownloads === 'number' ? share.usedDownloads : 0,
      pickup_code: (typeof share.pickupCode === 'string' && share.pickupCode) ? share.pickupCode : null,
      created_at: isoToMs(share.createdAt),
    });
    await this.db.prepare(
      'INSERT INTO shares (token, file_id, folder_id, code, burn, max_downloads, used_downloads, pickup_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.token, item.fileId, item.folderId, item.code, item.burn ? 1 : 0,
      item.maxDownloads, item.usedDownloads, item.pickupCode, isoToMs(item.createdAt),
    ).run();
    return item;
  }
  async updateShare(token, patch) {
    const cur = await this.getShareByToken(token);
    if (!cur) return null;
    const next = { ...cur };
    if (patch.code !== undefined) next.code = patch.code ? patch.code : '';
    if (patch.burn !== undefined) next.burn = !!patch.burn;
    if (patch.maxDownloads !== undefined) next.maxDownloads = Math.max(0, Math.floor(Number(patch.maxDownloads)) || 0);
    if (patch.usedDownloads !== undefined) next.usedDownloads = Math.max(0, Math.floor(Number(patch.usedDownloads)) || 0);
    if (patch.pickupCode !== undefined) next.pickupCode = (typeof patch.pickupCode === 'string' && patch.pickupCode) ? patch.pickupCode : null;
    await this.db.prepare(
      'UPDATE shares SET code = ?, burn = ?, max_downloads = ?, used_downloads = ?, pickup_code = ? WHERE token = ?',
    ).bind(next.code, next.burn ? 1 : 0, next.maxDownloads, next.usedDownloads, next.pickupCode, token).run();
    return next;
  }
  async incrementShareDownloads(token) {
    const out = await this.db.prepare(
      'UPDATE shares SET used_downloads = used_downloads + 1 WHERE token = ? AND (max_downloads = 0 OR used_downloads < max_downloads)',
    ).bind(token).run();
    return (out.meta && typeof out.meta.changes === 'number') ? out.meta.changes : 0;
  }
  async deleteShare(token) {
    const out = await this.db.prepare('DELETE FROM shares WHERE token = ?').bind(token).run();
    return (out.meta && out.meta.changes > 0) || false;
  }

  // ---- API tokens (v3.1) ----
  _rowToApiToken(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scope: r.scope || 'upload',
      lastUsedAt: (typeof r.last_used_at === 'number') ? r.last_used_at : null,
      createdAt: r.created_at,
    };
  }
  async createApiToken(t) {
    const item = {
      id: t.id, name: t.name, prefix: t.prefix, scope: t.scope || 'upload',
      lastUsedAt: null, createdAt: t.createdAt,
    };
    await this.db.prepare(
      'INSERT INTO api_tokens (id, name, token_hash, prefix, scope, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(item.id, item.name, t.tokenHash, item.prefix, item.scope, null, item.createdAt).run();
    return item;
  }
  async getApiTokenByHash(tokenHash) {
    const r = await this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').bind(tokenHash).first();
    return this._rowToApiToken(r);
  }
  async listApiTokens() {
    const { results } = await this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all();
    return (results || []).map((r) => this._rowToApiToken(r));
  }
  async deleteApiToken(id) {
    const out = await this.db.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
    return (out.meta && out.meta.changes > 0) || false;
  }
  async touchApiToken(id) {
    await this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), id).run();
  }

  // ---- sessions ----
  async getSession(token) {
    const r = await this.db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
    if (!r) return null;
    if (Date.now() > r.expires_at) {
      await this.db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return null;
    }
    return { token, username: 'admin', expiresAt: r.expires_at };
  }
  async createSession(token, expiresAt) {
    await this.db.prepare(
      'INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?, ?)',
    ).bind(token, expiresAt).run();
  }
  async deleteSession(token) {
    await this.db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  async deleteExpiredSessions(now) {
    await this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
    await this.db.prepare('DELETE FROM login_attempts WHERE at < ?').bind(now - FAIL_WINDOW_MS).run();
  }

  // ---- announcement ----
  async getAnnouncement() {
    const r = await this.db.prepare('SELECT text FROM announcement WHERE id = 1').first();
    return (r && typeof r.text === 'string') ? r.text : '';
  }
  async setAnnouncement(text) {
    await this.db.prepare(
      'INSERT OR REPLACE INTO announcement (id, text) VALUES (1, ?)',
    ).bind(text).run();
  }

  // ---- settings (v3.1.6) ----
  async getSetting(key) {
    try {
      const r = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(String(key)).first();
      return (r && typeof r.value === 'string') ? r.value : null;
    } catch {
      return null;
    }
  }
  async setSetting(key, value) {
    await this.db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).bind(String(key), String(value ?? ''), Date.now()).run();
  }

  // ---- storage pools (v3.2) ----
  _rowToPool(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      type: r.type || 's3',
      endpoint: r.endpoint,
      bucket: r.bucket,
      region: r.region || 'auto',
      accessKeyId: r.access_key_id,
      secretKeyEnc: r.secret_key_enc,
      publicDomain: r.public_domain || '',
      transferMode: r.transfer_mode === 'proxy' ? 'proxy' : 'presign',
      quotaBytes: typeof r.quota_bytes === 'number' && r.quota_bytes > 0 ? r.quota_bytes : 10737418240,
      enabled: r.enabled !== 0,
      isDefault: r.is_default === 1,
      sortOrder: typeof r.sort_order === 'number' ? r.sort_order : 0,
      createdAt: r.created_at,
    };
  }
  async listStoragePools() {
    try {
      const { results } = await this.db.prepare(
        'SELECT * FROM storage_pools ORDER BY sort_order ASC, created_at ASC',
      ).all();
      return (results || []).map((r) => this._rowToPool(r));
    } catch {
      return [];
    }
  }
  async getStoragePool(id) {
    if (!id) return null;
    try {
      const r = await this.db.prepare('SELECT * FROM storage_pools WHERE id = ?').bind(String(id)).first();
      return this._rowToPool(r);
    } catch {
      return null;
    }
  }
  async createStoragePool(p) {
    const item = {
      id: p.id,
      name: p.name,
      type: p.type || 's3',
      endpoint: p.endpoint,
      bucket: p.bucket,
      region: p.region || 'auto',
      accessKeyId: p.accessKeyId,
      secretKeyEnc: p.secretKeyEnc,
      publicDomain: p.publicDomain || '',
      transferMode: p.transferMode === 'proxy' ? 'proxy' : 'presign',
      quotaBytes: Number(p.quotaBytes) > 0 ? Math.floor(Number(p.quotaBytes)) : 10737418240,
      enabled: p.enabled !== false,
      isDefault: !!p.isDefault,
      sortOrder: Number.isFinite(Number(p.sortOrder)) ? Math.floor(Number(p.sortOrder)) : 0,
      createdAt: p.createdAt || Date.now(),
    };
    if (item.isDefault) {
      await this.db.prepare('UPDATE storage_pools SET is_default = 0').run();
    }
    await this.db.prepare(
      'INSERT INTO storage_pools (id, name, type, endpoint, bucket, region, access_key_id, secret_key_enc, public_domain, transfer_mode, quota_bytes, enabled, is_default, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.id, item.name, item.type, item.endpoint, item.bucket, item.region,
      item.accessKeyId, item.secretKeyEnc, item.publicDomain, item.transferMode,
      item.quotaBytes, item.enabled ? 1 : 0, item.isDefault ? 1 : 0, item.sortOrder, item.createdAt,
    ).run();
    return item;
  }
  async updateStoragePool(id, patch) {
    const cur = await this.getStoragePool(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    next.transferMode = next.transferMode === 'proxy' ? 'proxy' : 'presign';
    next.quotaBytes = Number(next.quotaBytes) > 0 ? Math.floor(Number(next.quotaBytes)) : 10737418240;
    next.enabled = next.enabled !== false;
    next.isDefault = !!next.isDefault;
    next.sortOrder = Number.isFinite(Number(next.sortOrder)) ? Math.floor(Number(next.sortOrder)) : 0;
    if (patch.isDefault === true) {
      await this.db.prepare('UPDATE storage_pools SET is_default = 0 WHERE id != ?').bind(id).run();
    }
    await this.db.prepare(
      'UPDATE storage_pools SET name = ?, type = ?, endpoint = ?, bucket = ?, region = ?, access_key_id = ?, secret_key_enc = ?, public_domain = ?, transfer_mode = ?, quota_bytes = ?, enabled = ?, is_default = ?, sort_order = ? WHERE id = ?',
    ).bind(
      next.name, next.type || 's3', next.endpoint, next.bucket, next.region || 'auto',
      next.accessKeyId, next.secretKeyEnc, next.publicDomain || '', next.transferMode,
      next.quotaBytes, next.enabled ? 1 : 0, next.isDefault ? 1 : 0, next.sortOrder, id,
    ).run();
    return next;
  }
  async deleteStoragePool(id) {
    const out = await this.db.prepare('DELETE FROM storage_pools WHERE id = ?').bind(String(id)).run();
    return (out.meta && out.meta.changes > 0) || false;
  }

  // ---- drop links / file collection boxes (v3.3.1) ----
  _rowToDropLink(r) {
    if (!r) return null;
    return {
      token: r.token,
      folderId: (typeof r.folder_id === 'string' && r.folder_id) ? r.folder_id : null,
      title: r.title || '文件收集',
      passwordHash: typeof r.password_hash === 'string' ? r.password_hash : '',
      maxFiles: typeof r.max_files === 'number' ? r.max_files : 0,
      usedFiles: typeof r.used_files === 'number' ? r.used_files : 0,
      maxFileSize: typeof r.max_file_size === 'number' && r.max_file_size > 0 ? r.max_file_size : 104857600,
      visibility: r.visibility === 'public' ? 'public' : 'private',
      expiresAt: msToIso(r.expires_at),
      createdAt: msToIso(r.created_at),
    };
  }
  async listDropLinks() {
    try {
      const { results } = await this.db.prepare(
        'SELECT * FROM drop_links ORDER BY created_at DESC',
      ).all();
      return (results || []).map((r) => this._rowToDropLink(r));
    } catch {
      return [];
    }
  }
  async getDropLink(token) {
    if (!token) return null;
    try {
      const r = await this.db.prepare('SELECT * FROM drop_links WHERE token = ?').bind(String(token)).first();
      return this._rowToDropLink(r);
    } catch {
      return null;
    }
  }
  async createDropLink(d) {
    const item = this._rowToDropLink({
      token: d.token,
      folder_id: d.folderId || null,
      title: d.title || '文件收集',
      password_hash: d.passwordHash || '',
      max_files: typeof d.maxFiles === 'number' && d.maxFiles >= 0 ? Math.floor(d.maxFiles) : 0,
      used_files: typeof d.usedFiles === 'number' && d.usedFiles >= 0 ? Math.floor(d.usedFiles) : 0,
      max_file_size: typeof d.maxFileSize === 'number' && d.maxFileSize > 0 ? Math.floor(d.maxFileSize) : 104857600,
      visibility: d.visibility === 'public' ? 'public' : 'private',
      expires_at: isoToMs(d.expiresAt),
      created_at: isoToMs(d.createdAt) || Date.now(),
    });
    await this.db.prepare(
      'INSERT INTO drop_links (token, folder_id, title, password_hash, max_files, used_files, max_file_size, visibility, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.token, item.folderId, item.title, item.passwordHash,
      item.maxFiles, item.usedFiles, item.maxFileSize, item.visibility,
      isoToMs(item.expiresAt), isoToMs(item.createdAt),
    ).run();
    return item;
  }
  async deleteDropLink(token) {
    const out = await this.db.prepare('DELETE FROM drop_links WHERE token = ?').bind(String(token)).run();
    return (out.meta && out.meta.changes > 0) || false;
  }
  async incrementDropLinkFiles(token) {
    const out = await this.db.prepare(
      'UPDATE drop_links SET used_files = used_files + 1 WHERE token = ? AND (max_files = 0 OR used_files < max_files)',
    ).bind(String(token)).run();
    return (out.meta && typeof out.meta.changes === 'number') ? out.meta.changes : 0;
  }

  // ---- login brute-force ----
  async recordFailure(ip, at) {
    await this.db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, at || Date.now()).run();
  }
  async clearFailures(ip) {
    await this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  }
  async countFailuresSince(ip, since) {
    const r = await this.db.prepare(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at >= ?',
    ).bind(ip, since).first();
    return (r && r.n) || 0;
  }
  async isBlocked(ip) {
    const n = await this.countFailuresSince(ip, Date.now() - FAIL_WINDOW_MS);
    return n >= FAIL_LIMIT;
  }

  // ---- chunk uploads ----
  async getChunkUpload(uploadId) {
    const r = await this.db.prepare('SELECT * FROM chunk_uploads WHERE upload_id = ?').bind(uploadId).first();
    return this._rowToChunk(r);
  }

  async createChunkUpload(u) {
    const storage = 'r2';
    const item = this._rowToChunk({
      upload_id: u.uploadId, r2_upload_id: u.r2UploadId || null,
      storage_key: u.storageKey || null, name: u.name, size: u.size, total: u.total,
      received: JSON.stringify(u.received || []), storage,
      folder_id: u.folderId || null, visibility: u.visibility || 'public',
      expires_hours: u.expiresHours || 0, created_at: u.createdAt || Date.now(),
      pool_id: (typeof u.poolId === 'string' && u.poolId) ? u.poolId : null,
    });
    await this.db.prepare(
      'INSERT INTO chunk_uploads (upload_id, r2_upload_id, storage_key, name, size, total, received, storage, folder_id, visibility, expires_hours, created_at, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.uploadId, item.r2UploadId, item.storageKey, item.name, item.size, item.total,
      JSON.stringify(item.received), item.storage, item.folderId, item.visibility,
      item.expiresHours, item.createdAt, item.poolId,
    ).run();
  }

  async updateChunkUpload(uploadId, patch) {
    const cur = await this.getChunkUpload(uploadId);
    if (!cur) return;
    const next = { ...cur, ...patch };
    await this.db.prepare(
      'UPDATE chunk_uploads SET r2_upload_id = ?, storage_key = ?, received = ?, storage = ?, folder_id = ?, visibility = ?, expires_hours = ?, pool_id = ? WHERE upload_id = ?',
    ).bind(
      next.r2UploadId || null, next.storageKey || null, JSON.stringify(next.received || []),
      next.storage || 'r2', next.folderId || null, next.visibility || 'public',
      next.expiresHours || 0, next.poolId || null, uploadId,
    ).run();
  }

  async deleteChunkUpload(uploadId, storageOverride) {
    const meta = await this.getChunkUpload(uploadId);
    const drv = storageOverride || this.r2;
    if (meta && meta.r2UploadId && drv) {
      try {
        await drv.abortMultipartUpload(meta.r2UploadId, meta.storageKey || (CHUNK_TMP_PREFIX + uploadId));
      } catch { /* already gone is fine */ }
    }
    await this.db.prepare('DELETE FROM chunk_uploads WHERE upload_id = ?').bind(uploadId).run();
  }

  async listStaleChunkUploads(before) {
    const { results } = await this.db.prepare(
      'SELECT * FROM chunk_uploads WHERE created_at < ?',
    ).bind(before).all();
    return (results || []).map((r) => this._rowToChunk(r));
  }

  async writeChunkPart(uploadId, index, buf, storageOverride) {
    const drv = storageOverride || this.r2;
    if (!drv) throw new Error('R2 storage is required for chunk uploads on CF');
    let meta = await this.getChunkUpload(uploadId);
    if (!meta) return null;
    const partNumber = index + 1;
    if (!meta.r2UploadId) {
      const tmpKey = CHUNK_TMP_PREFIX + uploadId;
      const contentType = MIME[extOf(meta.name)] || 'application/octet-stream';
      const r2UploadId = await drv.createMultipartUpload(tmpKey, contentType);
      meta.r2UploadId = r2UploadId;
      meta.storageKey = tmpKey;
      await this.updateChunkUpload(uploadId, { r2UploadId, storageKey: tmpKey });
    }
    const { etag } = await drv.uploadPart(meta.r2UploadId, meta.storageKey, partNumber, buf);
    if (!meta.received.some((r) => r.partNumber === index)) {
      meta.received.push({ partNumber: index, etag });
      meta.received.sort((a, b) => a.partNumber - b.partNumber);
    } else {
      const cur = meta.received.find((r) => r.partNumber === index);
      if (cur) cur.etag = etag;
    }
    await this.updateChunkUpload(uploadId, { received: meta.received });
    return meta;
  }

  async readChunkPart() {
    return null;
  }

  async chunkPartExists(uploadId, index) {
    const meta = await this.getChunkUpload(uploadId);
    return !!meta && meta.received.some((r) => r.partNumber === index);
  }

  async assembleChunks(uploadId, _tmpPath, storageOverride) {
    const drv = storageOverride || this.r2;
    if (!drv) throw new Error('R2 storage is required for chunk uploads on CF');
    const meta = await this.getChunkUpload(uploadId);
    if (!meta || !meta.r2UploadId) throw new Error('chunk meta missing');
    const parts = meta.received
      .map((p) => ({ partNumber: p.partNumber + 1, etag: p.etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    await drv.completeMultipartUpload(meta.r2UploadId, meta.storageKey, parts);
    const head = await drv.head(meta.storageKey);
    if (!head) throw new Error('assembled object missing after complete');
    return head.size;
  }
}
