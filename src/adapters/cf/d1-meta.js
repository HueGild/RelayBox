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
      deletedAt: msToIso(r.deleted_at),
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
      expiresAt: msToIso(r.expires_at),
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

  _orderByForSort(sort) {
    switch (sort) {
      case 'time-asc': return 'uploaded_at ASC';
      case 'name-asc': return 'lower(name) ASC, uploaded_at DESC';
      case 'name-desc': return 'lower(name) DESC, uploaded_at DESC';
      case 'size-desc': return 'size DESC, uploaded_at DESC';
      case 'size-asc': return 'size ASC, uploaded_at DESC';
      case 'time-desc':
      default: return 'uploaded_at DESC';
    }
  }

  async listFiles(folderId, { authed, limit = 0, offset = 0, sort = 'time-desc' } = {}) {
    const now = Date.now();
    const orderBy = this._orderByForSort(sort);
    const baseSql = `SELECT * FROM files WHERE folder_id IS ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?) ORDER BY ${orderBy}`;
    if (Number.isInteger(limit) && limit > 0) {
      const safeOffset = (Number.isInteger(offset) && offset > 0) ? offset : 0;
      const { results } = await this.db.prepare(`${baseSql} LIMIT ? OFFSET ?`)
        .bind(folderId || null, now, authed ? 1 : 0, 'public', limit, safeOffset).all();
      return (results || []).map((r) => this._rowToFile(r));
    }
    const { results } = await this.db.prepare(baseSql)
      .bind(folderId || null, now, authed ? 1 : 0, 'public').all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  /**
   * Single D1 db.batch() round-trip for GET /api/files (folders, page files,
   * folder stats, folder counts, pool usage stats, and optional trash stats).
   */
  async getDirListingBundle(folderId, { authed, limit = 0, offset = 0, sort = 'time-desc' } = {}) {
    const now = Date.now();
    const orderBy = this._orderByForSort(sort);
    const authedFlag = authed ? 1 : 0;
    const fid = folderId || null;

    if (typeof this.db.batch !== 'function') {
      const [folders, files, folderStats, fileCountByFolder, poolUsageMap, trashStats] = await Promise.all([
        this.listFolders(),
        this.listFiles(fid, { authed, limit, offset, sort }),
        this.getFolderFileStats(fid, { authed }),
        this.getFolderFileCounts({ authed }),
        this.getPoolUsageStats({ includeTrashed: true }),
        authed ? this.getTrashStats() : Promise.resolve({ count: 0, totalBytes: 0 }),
      ]);
      return { folders, files, folderStats, fileCountByFolder, poolUsageMap, trashStats };
    }

    const baseFilesSql = `SELECT * FROM files WHERE folder_id IS ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?) ORDER BY ${orderBy}`;
    const filesStmt = (Number.isInteger(limit) && limit > 0)
      ? this.db.prepare(`${baseFilesSql} LIMIT ? OFFSET ?`).bind(fid, now, authedFlag, 'public', limit, (Number.isInteger(offset) && offset > 0) ? offset : 0)
      : this.db.prepare(baseFilesSql).bind(fid, now, authedFlag, 'public');

    const stmts = [
      this.db.prepare('SELECT * FROM folders'),
      filesStmt,
      this.db.prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes, COALESCE(SUM(CASE WHEN storage = 'r2' THEN size ELSE 0 END), 0) AS r2_bytes, COALESCE(SUM(CASE WHEN storage != 'r2' THEN size ELSE 0 END), 0) AS local_bytes FROM files WHERE folder_id IS ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?)",
      ).bind(fid, now, authedFlag, 'public'),
      this.db.prepare(
        'SELECT folder_id, COUNT(*) AS cnt FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?) AND folder_id IS NOT NULL GROUP BY folder_id',
      ).bind(now, authedFlag, 'public'),
      this.db.prepare(
        "SELECT CASE WHEN pool_id IS NOT NULL AND pool_id != '' THEN pool_id WHEN storage = 'r2' THEN 'builtin-r2' ELSE 'builtin-local' END AS effective_pool_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS used_bytes, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_count, SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash_count FROM files WHERE (deleted_at IS NOT NULL OR expires_at IS NULL OR expires_at > ?) GROUP BY effective_pool_id",
      ).bind(now),
    ];
    if (authed) {
      stmts.push(this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM files WHERE deleted_at IS NOT NULL'));
    }

    const res = await this.db.batch(stmts);
    const folders = ((res[0] && res[0].results) || []).map((r) => this._rowToFolder(r));
    const files = ((res[1] && res[1].results) || []).map((r) => this._rowToFile(r));
    const fsRow = (res[2] && res[2].results && res[2].results[0]) || null;
    const folderStats = {
      count: Number((fsRow && fsRow.count) || 0),
      totalBytes: Number((fsRow && fsRow.total_bytes) || 0),
      r2Bytes: Number((fsRow && fsRow.r2_bytes) || 0),
      localBytes: Number((fsRow && fsRow.local_bytes) || 0),
    };
    const fileCountByFolder = new Map();
    for (const r of ((res[3] && res[3].results) || [])) {
      if (r && r.folder_id) fileCountByFolder.set(r.folder_id, Number(r.cnt || 0));
    }
    const poolUsageMap = new Map();
    for (const r of ((res[4] && res[4].results) || [])) {
      if (!r || !r.effective_pool_id) continue;
      poolUsageMap.set(r.effective_pool_id, {
        fileCount: Number(r.file_count || 0),
        usedBytes: Number(r.used_bytes || 0),
        activeCount: Number(r.active_count || 0),
        trashCount: Number(r.trash_count || 0),
      });
    }
    const trRow = authed ? ((res[5] && res[5].results && res[5].results[0]) || null) : null;
    const trashStats = {
      count: Number((trRow && trRow.count) || 0),
      totalBytes: Number((trRow && trRow.total_bytes) || 0),
    };
    return { folders, files, folderStats, fileCountByFolder, poolUsageMap, trashStats };
  }

  /**
   * Batch duplicate detection for pre-upload check across one or more folders.
   * Returns a Set of matched keys `${folderId || ''}::${name}::${size}`.
   */
  async findDuplicatesInFolders(items) {
    const matched = new Set();
    if (!Array.isArray(items) || !items.length) return matched;
    const now = Date.now();
    // Group unique names per folderId to keep SQL compact
    const byFolder = new Map();
    for (const it of items) {
      if (!it || typeof it.name !== 'string' || !it.name) continue;
      const fk = it.folderId ? String(it.folderId) : '';
      let names = byFolder.get(fk);
      if (!names) { names = new Set(); byFolder.set(fk, names); }
      names.add(it.name);
    }
    const BATCH = 40;
    for (const [fk, nameSet] of byFolder.entries()) {
      const fid = fk || null;
      const nameList = [...nameSet];
      for (let i = 0; i < nameList.length; i += BATCH) {
        const slice = nameList.slice(i, i + BATCH);
        const ph = slice.map(() => '?').join(', ');
        const { results } = await this.db.prepare(
          `SELECT name, size FROM files WHERE folder_id IS ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND name IN (${ph})`,
        ).bind(fid, now, ...slice).all();
        for (const r of (results || [])) {
          matched.add(`${fk}::${r.name}::${Number(r.size || 0)}`);
        }
      }
    }
    return matched;
  }

  async getFolderFileStats(folderId, { authed } = {}) {
    const now = Date.now();
    const r = await this.db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes, COALESCE(SUM(CASE WHEN storage = 'r2' THEN size ELSE 0 END), 0) AS r2_bytes, COALESCE(SUM(CASE WHEN storage != 'r2' THEN size ELSE 0 END), 0) AS local_bytes FROM files WHERE folder_id IS ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?)",
    ).bind(folderId || null, now, authed ? 1 : 0, 'public').first();
    return {
      count: Number((r && r.count) || 0),
      totalBytes: Number((r && r.total_bytes) || 0),
      r2Bytes: Number((r && r.r2_bytes) || 0),
      localBytes: Number((r && r.local_bytes) || 0),
    };
  }

  async getFolderFileCounts({ authed } = {}) {
    const now = Date.now();
    const { results } = await this.db.prepare(
      'SELECT folder_id, COUNT(*) AS cnt FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?) AND folder_id IS NOT NULL GROUP BY folder_id',
    ).bind(now, authed ? 1 : 0, 'public').all();
    const map = new Map();
    for (const r of (results || [])) {
      if (r && r.folder_id) map.set(r.folder_id, Number(r.cnt || 0));
    }
    return map;
  }

  async getTrashStats() {
    const r = await this.db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM files WHERE deleted_at IS NOT NULL',
    ).first();
    return {
      count: Number((r && r.count) || 0),
      totalBytes: Number((r && r.total_bytes) || 0),
    };
  }

  async getPoolUsageStats({ includeTrashed = true } = {}) {
    const now = Date.now();
    const sql = includeTrashed
      ? `SELECT CASE WHEN pool_id IS NOT NULL AND pool_id != '' THEN pool_id WHEN storage = 'r2' THEN 'builtin-r2' ELSE 'builtin-local' END AS effective_pool_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS used_bytes, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_count, SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash_count FROM files WHERE (deleted_at IS NOT NULL OR expires_at IS NULL OR expires_at > ?) GROUP BY effective_pool_id`
      : `SELECT CASE WHEN pool_id IS NOT NULL AND pool_id != '' THEN pool_id WHEN storage = 'r2' THEN 'builtin-r2' ELSE 'builtin-local' END AS effective_pool_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS used_bytes, COUNT(*) AS active_count, 0 AS trash_count FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY effective_pool_id`;
    const { results } = await this.db.prepare(sql).bind(now).all();
    const map = new Map();
    for (const r of (results || [])) {
      if (!r || !r.effective_pool_id) continue;
      map.set(r.effective_pool_id, {
        fileCount: Number(r.file_count || 0),
        usedBytes: Number(r.used_bytes || 0),
        activeCount: Number(r.active_count || 0),
        trashCount: Number(r.trash_count || 0),
      });
    }
    return map;
  }

  async getActiveFileSummary() {
    const now = Date.now();
    const r = await this.db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
    ).bind(now).first();
    return {
      count: Number((r && r.count) || 0),
      totalBytes: Number((r && r.total_bytes) || 0),
    };
  }

  async hasFileWithName(folderId, name, excludeId = null) {
    const r = await this.db.prepare(
      'SELECT 1 FROM files WHERE folder_id IS ? AND name = ? AND deleted_at IS NULL AND (? IS NULL OR id != ?) LIMIT 1',
    ).bind(folderId || null, name, excludeId || null, excludeId || null).first();
    return !!r;
  }

  async hasFilesInFolder(folderId) {
    const r = await this.db.prepare(
      'SELECT 1 FROM files WHERE folder_id IS ? AND deleted_at IS NULL LIMIT 1',
    ).bind(folderId || null).first();
    return !!r;
  }

  _poolWhereClause(poolId) {
    if (poolId === 'builtin-r2') {
      return { sql: "(pool_id IS NULL OR pool_id = '') AND storage = 'r2'", binds: [] };
    }
    if (poolId === 'builtin-local') {
      return { sql: "(pool_id IS NULL OR pool_id = '') AND storage != 'r2'", binds: [] };
    }
    return { sql: 'pool_id = ?', binds: [poolId] };
  }

  async listFilesByPool(poolId, { includeTrashed = false, limit = 0 } = {}) {
    const now = Date.now();
    const pw = this._poolWhereClause(poolId);
    const trashClause = includeTrashed
      ? '(deleted_at IS NOT NULL OR expires_at IS NULL OR expires_at > ?)'
      : 'deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)';
    let sql = `SELECT * FROM files WHERE ${pw.sql} AND ${trashClause} ORDER BY uploaded_at DESC`;
    const binds = [...pw.binds, now];
    if (Number.isInteger(limit) && limit > 0) {
      sql += ' LIMIT ?';
      binds.push(limit);
    }
    const { results } = await this.db.prepare(sql).bind(...binds).all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async countFilesByPool(poolId, { includeTrashed = false } = {}) {
    const now = Date.now();
    const pw = this._poolWhereClause(poolId);
    const trashClause = includeTrashed
      ? '(deleted_at IS NOT NULL OR expires_at IS NULL OR expires_at > ?)'
      : 'deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)';
    const r = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM files WHERE ${pw.sql} AND ${trashClause}`,
    ).bind(...pw.binds, now).first();
    return Number((r && r.count) || 0);
  }

  async listExpiredFiles(now = Date.now()) {
    const { results } = await this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?',
    ).bind(now).all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async listTrashExpiredFiles(cutoffMs) {
    const { results } = await this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NOT NULL AND deleted_at <= ?',
    ).bind(cutoffMs).all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async getFilesByIds(ids, { includeTrashed = false } = {}) {
    const uniq = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
    if (!uniq.length) return [];
    const out = [];
    const BATCH = 50;
    for (let i = 0; i < uniq.length; i += BATCH) {
      const slice = uniq.slice(i, i + BATCH);
      const ph = slice.map(() => '?').join(', ');
      const sql = includeTrashed
        ? `SELECT * FROM files WHERE id IN (${ph})`
        : `SELECT * FROM files WHERE deleted_at IS NULL AND id IN (${ph})`;
      const { results } = await this.db.prepare(sql).bind(...slice).all();
      for (const r of (results || [])) out.push(this._rowToFile(r));
    }
    return out;
  }

  async listFilesInFolders(folderIds) {
    const list = Array.isArray(folderIds) ? folderIds : [];
    const hasRoot = list.some((x) => x === null || x === '' || x === undefined);
    const nonNull = [...new Set(list.filter((x) => typeof x === 'string' && x))];
    const out = [];
    if (hasRoot) {
      const { results } = await this.db.prepare(
        'SELECT * FROM files WHERE deleted_at IS NULL AND folder_id IS NULL',
      ).all();
      for (const r of (results || [])) out.push(this._rowToFile(r));
    }
    const BATCH = 50;
    for (let i = 0; i < nonNull.length; i += BATCH) {
      const slice = nonNull.slice(i, i + BATCH);
      const ph = slice.map(() => '?').join(', ');
      const { results } = await this.db.prepare(
        `SELECT * FROM files WHERE deleted_at IS NULL AND folder_id IN (${ph})`,
      ).bind(...slice).all();
      for (const r of (results || [])) out.push(this._rowToFile(r));
    }
    return out;
  }

  async getDashboardStats(now = Date.now()) {
    const CST_OFFSET_MS = 8 * 3600 * 1000;
    const cstNow = new Date(now + CST_OFFSET_MS);
    const todayCstStartUtc = Date.UTC(cstNow.getUTCFullYear(), cstNow.getUTCMonth(), cstNow.getUTCDate()) - CST_OFFSET_MS;
    const sevenDaysStartMs = todayCstStartUtc - 6 * 24 * 3600 * 1000;

    const stmts = [
      this.db.prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes, COALESCE(SUM(downloads), 0) AS total_downloads FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
      ).bind(now),
      this.db.prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM files WHERE deleted_at IS NOT NULL',
      ),
      this.db.prepare('SELECT COUNT(*) AS count FROM folders'),
      this.db.prepare(
        'SELECT COUNT(*) AS count FROM shares WHERE (expires_at IS NULL OR expires_at > ?) AND (max_downloads = 0 OR used_downloads < max_downloads)',
      ).bind(now),
      this.db.prepare(
        'SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY kind ORDER BY bytes DESC',
      ).bind(now),
      this.db.prepare(
        'SELECT id, name, kind, size, downloads, folder_id, visibility, uploaded_at FROM files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND downloads > 0 ORDER BY downloads DESC, uploaded_at DESC LIMIT 10',
      ).bind(now),
      this.db.prepare(
        "SELECT strftime('%Y-%m-%d', (uploaded_at + 28800000) / 1000, 'unixepoch') AS day, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE deleted_at IS NULL AND uploaded_at >= ? GROUP BY day ORDER BY day ASC",
      ).bind(sevenDaysStartMs),
    ];
    let overviewRow, trashRow, folderRow, shareRow, kindRows, topRows, trendRows;
    if (typeof this.db.batch === 'function') {
      const b = await this.db.batch(stmts);
      overviewRow = (b[0] && b[0].results && b[0].results[0]) || null;
      trashRow = (b[1] && b[1].results && b[1].results[0]) || null;
      folderRow = (b[2] && b[2].results && b[2].results[0]) || null;
      shareRow = (b[3] && b[3].results && b[3].results[0]) || null;
      kindRows = b[4] || { results: [] };
      topRows = b[5] || { results: [] };
      trendRows = b[6] || { results: [] };
    } else {
      [overviewRow, trashRow, folderRow, shareRow, kindRows, topRows, trendRows] = await Promise.all([
        stmts[0].first(), stmts[1].first(), stmts[2].first(), stmts[3].first(),
        stmts[4].all(), stmts[5].all(), stmts[6].all(),
      ]);
    }

    const totalBytes = Number((overviewRow && overviewRow.total_bytes) || 0);
    const totalFiles = Number((overviewRow && overviewRow.count) || 0);
    const byKind = (kindRows && kindRows.results ? kindRows.results : []).map((r) => {
      const bytes = Number(r.bytes || 0);
      const count = Number(r.count || 0);
      return {
        kind: r.kind || 'file',
        count,
        bytes,
        pctBytes: totalBytes > 0 ? Number(((bytes / totalBytes) * 100).toFixed(1)) : 0,
        pctCount: totalFiles > 0 ? Number(((count / totalFiles) * 100).toFixed(1)) : 0,
      };
    });

    const topDownloads = (topRows && topRows.results ? topRows.results : []).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind || 'file',
      size: Number(r.size || 0),
      downloads: Number(r.downloads || 0),
      folderId: (typeof r.folder_id === 'string' && r.folder_id) ? r.folder_id : null,
      visibility: r.visibility === 'private' ? 'private' : 'public',
      uploadedAt: msToIso(r.uploaded_at),
    }));

    const trendMap = new Map();
    for (const r of (trendRows && trendRows.results ? trendRows.results : [])) {
      if (r && r.day) trendMap.set(r.day, { count: Number(r.count || 0), bytes: Number(r.bytes || 0) });
    }
    const uploadTrend7d = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysStartMs + i * 24 * 3600 * 1000 + CST_OFFSET_MS);
      const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const hit = trendMap.get(day) || { count: 0, bytes: 0 };
      uploadTrend7d.push({ day, count: hit.count, bytes: hit.bytes });
    }

    return {
      overview: {
        totalFiles,
        totalBytes,
        totalDownloads: Number((overviewRow && overviewRow.total_downloads) || 0),
        trashFiles: Number((trashRow && trashRow.count) || 0),
        trashBytes: Number((trashRow && trashRow.total_bytes) || 0),
        totalFolders: Number((folderRow && folderRow.count) || 0),
        activeShares: Number((shareRow && shareRow.count) || 0),
      },
      byKind,
      topDownloads,
      uploadTrend7d,
    };
  }

  async listAllFiles({ authed, includeTrashed = false } = {}) {
    const sql = includeTrashed
      ? 'SELECT * FROM files WHERE (? OR visibility = ?)'
      : 'SELECT * FROM files WHERE deleted_at IS NULL AND (? OR visibility = ?)';
    const { results } = await this.db.prepare(sql).bind(authed ? 1 : 0, 'public').all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async listTrashedFiles() {
    const { results } = await this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    ).all();
    return (results || []).map((r) => this._rowToFile(r));
  }

  async searchFiles(q, { authed } = {}) {
    const needle = String(q || '').toLowerCase();
    if (!needle) return [];
    const now = Date.now();
    const esc = needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { results } = await this.db.prepare(
      "SELECT * FROM files WHERE deleted_at IS NULL AND lower(name) LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) AND (? OR visibility = ?)",
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
      deleted_at: isoToMs(file.deletedAt),
    });
    await this.db.prepare(
      'INSERT INTO files (id, name, size, ext, kind, storage, storage_key, folder_id, visibility, expires_at, downloads, uploaded_at, upload_ip, upload_geo, width, height, pool_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.id, item.name, item.size, item.ext, item.kind, item.storage, item.storageKey,
      item.folderId, item.visibility, isoToMs(item.expiresAt), item.downloads, isoToMs(item.uploadedAt),
      item.uploadIp, item.uploadGeo, item.width, item.height, item.poolId, isoToMs(item.deletedAt),
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
      deleted_at: isoToMs(next.deletedAt),
    };
    await this.db.prepare(
      'UPDATE files SET name = ?, size = ?, ext = ?, kind = ?, storage = ?, storage_key = ?, folder_id = ?, visibility = ?, expires_at = ?, downloads = ?, uploaded_at = ?, upload_ip = ?, upload_geo = ?, width = ?, height = ?, pool_id = ?, deleted_at = ? WHERE id = ?',
    ).bind(
      row.name, row.size, row.ext, row.kind, row.storage, row.storage_key,
      row.folder_id, row.visibility, row.expires_at, row.downloads, row.uploaded_at,
      row.upload_ip, row.upload_geo, row.width, row.height, row.pool_id, row.deleted_at, id,
    ).run();
    return this._rowToFile(row);
  }

  async batchUpdateFiles(ids, patch) {
    const uniq = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
    if (!uniq.length) return { updatedIds: [], notFoundIds: [] };
    const sets = [];
    const vals = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'folderId')) {
      sets.push('folder_id = ?');
      vals.push((typeof patch.folderId === 'string' && patch.folderId) ? patch.folderId : null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'visibility')) {
      sets.push('visibility = ?');
      vals.push(patch.visibility === 'private' ? 'private' : 'public');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) {
      sets.push('expires_at = ?');
      vals.push(isoToMs(patch.expiresAt));
    }
    if (!sets.length) return { updatedIds: [], notFoundIds: uniq };
    const CHUNK = 80;
    const found = new Set();
    const updateStmts = [];
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const part = uniq.slice(i, i + CHUNK);
      const ph = part.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(`SELECT id FROM files WHERE id IN (${ph}) AND deleted_at IS NULL`)
        .bind(...part)
        .all();
      const activeIds = (results || []).map((r) => r.id);
      for (const id of activeIds) found.add(id);
      if (activeIds.length) {
        const upPh = activeIds.map(() => '?').join(',');
        updateStmts.push(
          this.db
            .prepare(`UPDATE files SET ${sets.join(', ')} WHERE id IN (${upPh}) AND deleted_at IS NULL`)
            .bind(...vals, ...activeIds),
        );
      }
    }
    if (updateStmts.length) {
      if (typeof this.db.batch === 'function') await this.db.batch(updateStmts);
      else for (const st of updateStmts) await st.run();
    }
    const updatedIds = uniq.filter((id) => found.has(id));
    const notFoundIds = uniq.filter((id) => !found.has(id));
    return { updatedIds, notFoundIds };
  }

  async batchTrashFiles(ids, deletedAt) {
    const uniq = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
    if (!uniq.length) return { trashedIds: [], alreadyTrashedIds: [], notFoundIds: [] };
    const delMs = isoToMs(deletedAt) || Date.now();
    const CHUNK = 80;
    const trashedIds = [];
    const alreadyTrashedIds = [];
    const found = new Set();
    const stmts = [];
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const part = uniq.slice(i, i + CHUNK);
      const ph = part.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(`SELECT id, deleted_at FROM files WHERE id IN (${ph})`)
        .bind(...part)
        .all();
      const toTrash = [];
      for (const r of (results || [])) {
        found.add(r.id);
        if (r.deleted_at) alreadyTrashedIds.push(r.id);
        else {
          toTrash.push(r.id);
          trashedIds.push(r.id);
        }
      }
      if (toTrash.length) {
        const tPh = toTrash.map(() => '?').join(',');
        stmts.push(
          this.db.prepare(`UPDATE files SET deleted_at = ? WHERE id IN (${tPh}) AND deleted_at IS NULL`).bind(delMs, ...toTrash),
          this.db.prepare(`DELETE FROM shares WHERE file_id IN (${tPh})`).bind(...toTrash),
        );
      }
    }
    if (stmts.length) {
      if (typeof this.db.batch === 'function') await this.db.batch(stmts);
      else for (const st of stmts) await st.run();
    }
    const notFoundIds = uniq.filter((id) => !found.has(id));
    return { trashedIds, alreadyTrashedIds, notFoundIds };
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
    const hasFiles = await this.db.prepare('SELECT 1 FROM files WHERE folder_id = ? AND deleted_at IS NULL LIMIT 1').bind(id).first();
    if (hasFiles) return false;
    const hasSubs = await this.db.prepare('SELECT 1 FROM folders WHERE parent_id = ? LIMIT 1').bind(id).first();
    if (hasSubs) return false;
    const out = await this.db.prepare('DELETE FROM folders WHERE id = ?').bind(id).run();
    return (out.meta && out.meta.changes > 0) || false;
  }

  // ---- shares ----
  async listShares() {
    const { results } = await this.db.prepare('SELECT * FROM shares').all();
    return (results || []).map((r) => this._rowToShare(r));
  }
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
      expires_at: isoToMs(share.expiresAt),
      created_at: isoToMs(share.createdAt),
    });
    await this.db.prepare(
      'INSERT INTO shares (token, file_id, folder_id, code, burn, max_downloads, used_downloads, pickup_code, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      item.token, item.fileId, item.folderId, item.code, item.burn ? 1 : 0,
      item.maxDownloads, item.usedDownloads, item.pickupCode, isoToMs(item.expiresAt), isoToMs(item.createdAt),
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
    if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt ? msToIso(isoToMs(patch.expiresAt)) : null;
    await this.db.prepare(
      'UPDATE shares SET code = ?, burn = ?, max_downloads = ?, used_downloads = ?, pickup_code = ?, expires_at = ? WHERE token = ?',
    ).bind(next.code, next.burn ? 1 : 0, next.maxDownloads, next.usedDownloads, next.pickupCode, isoToMs(next.expiresAt), token).run();
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
  async deleteExpiredShares(now = Date.now()) {
    const out = await this.db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run();
    return (out.meta && typeof out.meta.changes === 'number') ? out.meta.changes : 0;
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
  async deleteExpiredDropLinks(now = Date.now()) {
    const out = await this.db.prepare('DELETE FROM drop_links WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run();
    return (out.meta && typeof out.meta.changes === 'number') ? out.meta.changes : 0;
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

