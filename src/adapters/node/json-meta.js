// RelayBox Node adapter — JsonMetaStore (VPS target).
// Implements the MetaStore contract on JSON files (data/files.json, shares.json,
// folders.json, sessions.json, announcement.json) + chunk parts under data/chunks/.

import fs from 'node:fs';
import path from 'node:path';
import { folderIdOf, isExpired, parseDim, SESSION_TTL, FAIL_WINDOW_MS, FAIL_LIMIT, FAIL_BLOCK_MS, CHUNK_SIZE } from '../../core/lib/util.js';

export class JsonMetaStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filesFile = path.join(dataDir, 'files.json');
    this.sharesFile = path.join(dataDir, 'shares.json');
    this.foldersFile = path.join(dataDir, 'folders.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.announceFile = path.join(dataDir, 'announcement.json');
    this.apiTokensFile = path.join(dataDir, 'api_tokens.json');
    this.chunksDir = path.join(dataDir, 'chunks');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(this.chunksDir, { recursive: true });
    this._queue = Promise.resolve();
    this._failures = new Map();
    this._sessions = new Map();
    this._loadSessions();
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _readJson(file, fallback) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  _writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  }

  // ---- file records ----
  _normalizeFile(f) {
    if (!f || typeof f !== 'object') return null;
    if (f.visibility !== 'public' && f.visibility !== 'private') f.visibility = 'public';
    if (f.storage !== 'r2') f.storage = 'local';
    if (typeof f.folderId !== 'string' || !f.folderId) f.folderId = null;
    if (typeof f.downloads !== 'number') f.downloads = 0;
    if (typeof f.storageKey !== 'string' || !f.storageKey) f.storageKey = `${f.id}_${f.name}`;
    f.uploadIp = (typeof f.uploadIp === 'string' && f.uploadIp) ? f.uploadIp : null;
    f.uploadGeo = (typeof f.uploadGeo === 'string' && f.uploadGeo) ? f.uploadGeo : null;
    f.width = parseDim(f.width);
    f.height = parseDim(f.height);
    return f;
  }
  _readFiles() {
    const list = this._readJson(this.filesFile, []);
    if (!Array.isArray(list)) return [];
    return list.map((f) => this._normalizeFile(f)).filter(Boolean);
  }
  _writeFiles(list) {
    this._writeJson(this.filesFile, list);
  }

  async getFile(id) {
    return this._readFiles().find((f) => f.id === id) || null;
  }
  async listFiles(folderId, { authed } = {}) {
    return this._readFiles().filter(
      (f) => folderIdOf(f) === (folderId || null) && !isExpired(f) && (authed || f.visibility === 'public'),
    );
  }
  async listAllFiles({ authed } = {}) {
    return this._readFiles().filter((f) => authed || f.visibility === 'public');
  }
  async searchFiles(q, { authed } = {}) {
    const needle = String(q || '').toLowerCase();
    if (!needle) return [];
    return this._readFiles().filter(
      (f) => !isExpired(f) && (authed || f.visibility === 'public') && f.name.toLowerCase().includes(needle),
    );
  }
  async createFile(file) {
    return this._enqueue(() => {
      const list = this._readFiles();
      const item = this._normalizeFile({ ...file });
      list.unshift(item);
      this._writeFiles(list);
      return item;
    });
  }
  async updateFile(id, patch) {
    return this._enqueue(() => {
      const list = this._readFiles();
      const item = list.find((f) => f.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      this._normalizeFile(item);
      this._writeFiles(list);
      return item;
    });
  }
  async deleteFile(id) {
    return this._enqueue(() => {
      const list = this._readFiles();
      const idx = list.findIndex((f) => f.id === id);
      if (idx === -1) return false;
      list.splice(idx, 1);
      this._writeFiles(list);
      return true;
    });
  }
  async incrementDownloads(id) {
    return this._enqueue(() => {
      const list = this._readFiles();
      const item = list.find((f) => f.id === id);
      if (!item) return;
      item.downloads = (item.downloads || 0) + 1;
      this._writeFiles(list);
    });
  }

  // ---- folders ----
  _normalizeFolder(f) {
    if (!f || typeof f !== 'object') return null;
    if (typeof f.parentId !== 'string' || !f.parentId) f.parentId = null;
    return f;
  }
  _readFolders() {
    const list = this._readJson(this.foldersFile, []);
    if (!Array.isArray(list)) return [];
    return list.map((f) => this._normalizeFolder(f)).filter(Boolean);
  }
  _writeFolders(list) {
    this._writeJson(this.foldersFile, list);
  }
  async listFolders() {
    return this._readFolders();
  }
  async getFolder(id) {
    return this._readFolders().find((f) => f.id === id) || null;
  }
  async createFolder(folder) {
    return this._enqueue(() => {
      const list = this._readFolders();
      const item = this._normalizeFolder({ ...folder });
      list.push(item);
      this._writeFolders(list);
      return item;
    });
  }
  async updateFolder(id, patch) {
    return this._enqueue(() => {
      const list = this._readFolders();
      const item = list.find((f) => f.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      this._normalizeFolder(item);
      this._writeFolders(list);
      return item;
    });
  }
  async deleteFolder(id) {
    return this._enqueue(() => {
      const folders = this._readFolders();
      const idx = folders.findIndex((f) => f.id === id);
      if (idx === -1) return false;
      const files = this._readFiles();
      if (files.some((f) => folderIdOf(f) === id)) return false;
      if (folders.some((f) => (f.parentId || null) === id)) return false;
      folders.splice(idx, 1);
      this._writeFolders(folders);
      return true;
    });
  }

  // ---- shares ----
  _normalizeShare(s) {
    if (!s || typeof s !== 'object') return null;
    const out = { ...s, code: typeof s.code === 'string' ? s.code : '', burn: s.burn === true };
    out.maxDownloads = (typeof s.maxDownloads === 'number' && Number.isFinite(s.maxDownloads) && s.maxDownloads >= 0)
      ? Math.floor(s.maxDownloads) : 0;
    out.usedDownloads = (typeof s.usedDownloads === 'number' && Number.isFinite(s.usedDownloads) && s.usedDownloads >= 0)
      ? Math.floor(s.usedDownloads) : 0;
    out.pickupCode = (typeof s.pickupCode === 'string' && s.pickupCode) ? s.pickupCode : null;
    return out;
  }
  _readShares() {
    const list = this._readJson(this.sharesFile, []);
    return Array.isArray(list) ? list : [];
  }
  _writeShares(list) {
    this._writeJson(this.sharesFile, list);
  }
  async getShareByToken(token) {
    const s = this._readShares().find((x) => x.token === token);
    return s ? this._normalizeShare(s) : null;
  }
  async getShareByFileId(fileId) {
    const s = this._readShares().find((x) => x.fileId === fileId);
    return s ? this._normalizeShare(s) : null;
  }
  async getShareByFolderId(folderId) {
    const s = this._readShares().find((x) => x.folderId === folderId);
    return s ? this._normalizeShare(s) : null;
  }
  async getShareByPickupCode(code) {
    const c = (typeof code === 'string' && code) ? code.trim().toUpperCase() : '';
    if (!c) return null;
    const s = this._readShares().find((x) => typeof x.pickupCode === 'string' && x.pickupCode.toUpperCase() === c);
    return s ? this._normalizeShare(s) : null;
  }
  async createShare(share) {
    return this._enqueue(() => {
      const list = this._readShares();
      const item = this._normalizeShare({ ...share });
      if (!item.code) delete item.code;
      if (!item.burn) delete item.burn;
      if (!item.pickupCode) delete item.pickupCode;
      list.push(item);
      this._writeShares(list);
      return this._normalizeShare(item);
    });
  }
  async updateShare(token, patch) {
    return this._enqueue(() => {
      const list = this._readShares();
      const item = list.find((x) => x.token === token);
      if (!item) return null;
      if (patch.code !== undefined) {
        if (patch.code) item.code = patch.code;
        else delete item.code;
      }
      if (patch.burn !== undefined) {
        if (patch.burn) item.burn = true;
        else delete item.burn;
      }
      if (patch.maxDownloads !== undefined) {
        item.maxDownloads = Math.max(0, Math.floor(Number(patch.maxDownloads)) || 0);
      }
      if (patch.usedDownloads !== undefined) {
        item.usedDownloads = Math.max(0, Math.floor(Number(patch.usedDownloads)) || 0);
      }
      if (patch.pickupCode !== undefined) {
        if (patch.pickupCode) item.pickupCode = patch.pickupCode;
        else delete item.pickupCode;
      }
      this._writeShares(list);
      return this._normalizeShare(item);
    });
  }
  async incrementShareDownloads(token) {
    return this._enqueue(() => {
      const list = this._readShares();
      const item = list.find((x) => x.token === token);
      if (!item) return 0;
      const s = this._normalizeShare(item);
      if (!(s.maxDownloads === 0 || s.usedDownloads < s.maxDownloads)) return 0;
      item.usedDownloads = s.usedDownloads + 1;
      this._writeShares(list);
      return 1;
    });
  }
  async deleteShare(token) {
    return this._enqueue(() => {
      const list = this._readShares();
      const next = list.filter((x) => x.token !== token);
      if (next.length === list.length) return false;
      this._writeShares(next);
      return true;
    });
  }

  // ---- API tokens (v3.1) ----
  _normalizeApiToken(t) {
    if (!t || typeof t !== 'object') return null;
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scope: (t.scope === 'all' || t.scope === 'upload') ? t.scope : 'upload',
      lastUsedAt: (typeof t.lastUsedAt === 'number') ? t.lastUsedAt : null,
      createdAt: t.createdAt,
    };
  }
  _readApiTokens() {
    const list = this._readJson(this.apiTokensFile, []);
    return Array.isArray(list) ? list : [];
  }
  _writeApiTokens(list) {
    this._writeJson(this.apiTokensFile, list);
  }
  async createApiToken(t) {
    return this._enqueue(() => {
      const list = this._readApiTokens();
      const item = this._normalizeApiToken({
        id: t.id, name: t.name, prefix: t.prefix, scope: t.scope || 'upload',
        lastUsedAt: null, createdAt: t.createdAt,
      });
      list.push({ ...item, tokenHash: t.tokenHash });
      this._writeApiTokens(list);
      return item;
    });
  }
  async getApiTokenByHash(tokenHash) {
    const t = this._readApiTokens().find((x) => x.tokenHash === tokenHash);
    return t ? this._normalizeApiToken(t) : null;
  }
  async listApiTokens() {
    return this._readApiTokens()
      .map((t) => this._normalizeApiToken(t))
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  async deleteApiToken(id) {
    return this._enqueue(() => {
      const list = this._readApiTokens();
      const next = list.filter((x) => x.id !== id);
      if (next.length === list.length) return false;
      this._writeApiTokens(next);
      return true;
    });
  }
  async touchApiToken(id) {
    return this._enqueue(() => {
      const list = this._readApiTokens();
      const item = list.find((x) => x.id === id);
      if (!item) return;
      item.lastUsedAt = Date.now();
      this._writeApiTokens(list);
    });
  }

  // ---- sessions ----
  _loadSessions() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      const now = Date.now();
      for (const [token, s] of arr) {
        if (s && s.createdAt && now - s.createdAt <= SESSION_TTL) this._sessions.set(token, s);
      }
    } catch { /* start empty */ }
  }
  _saveSessions() {
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify([...this._sessions.entries()]), 'utf8');
    } catch { /* ignore */ }
  }
  async getSession(token) {
    const s = this._sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL) {
      this._sessions.delete(token);
      this._enqueue(() => this._saveSessions());
      return null;
    }
    return { token, username: s.username || 'admin', expiresAt: s.createdAt + SESSION_TTL };
  }
  async createSession(token, expiresAt) {
    this._sessions.set(token, { username: 'admin', createdAt: expiresAt - SESSION_TTL });
    return this._enqueue(() => this._saveSessions());
  }
  async deleteSession(token) {
    this._sessions.delete(token);
    return this._enqueue(() => this._saveSessions());
  }
  async deleteExpiredSessions(now) {
    return this._enqueue(() => {
      let changed = false;
      for (const [token, s] of this._sessions) {
        if (now - s.createdAt > SESSION_TTL) {
          this._sessions.delete(token);
          changed = true;
        }
      }
      if (changed) this._saveSessions();
    });
  }

  // ---- announcement ----
  async getAnnouncement() {
    try {
      const t = JSON.parse(fs.readFileSync(this.announceFile, 'utf8')).text;
      return typeof t === 'string' ? t : '';
    } catch {
      return '';
    }
  }
  async setAnnouncement(text) {
    return this._enqueue(() => {
      fs.writeFileSync(this.announceFile, JSON.stringify({ text }));
    });
  }

  // ---- login brute-force ----
  async recordFailure(ip, at) {
    const now = at || Date.now();
    let rec = this._failures.get(ip);
    if (!rec || now - rec.firstAt > FAIL_WINDOW_MS) rec = { count: 0, firstAt: now, blockedUntil: 0 };
    rec.count++;
    if (rec.count >= FAIL_LIMIT) rec.blockedUntil = now + FAIL_BLOCK_MS;
    this._failures.set(ip, rec);
    if (this._failures.size > 1000) {
      for (const [k, v] of this._failures) {
        if (now > (v.blockedUntil || v.firstAt + FAIL_WINDOW_MS)) this._failures.delete(k);
      }
    }
  }
  async clearFailures(ip) {
    this._failures.delete(ip);
  }
  async countFailuresSince(ip, since) {
    const rec = this._failures.get(ip);
    return rec && rec.firstAt >= since ? rec.count : 0;
  }
  async isBlocked(ip) {
    const rec = this._failures.get(ip);
    return !!(rec && rec.blockedUntil && Date.now() < rec.blockedUntil);
  }

  // ---- chunk uploads ----
  _chunkDir(uploadId) {
    return path.join(this.chunksDir, uploadId);
  }
  _chunkMetaPath(uploadId) {
    return path.join(this._chunkDir(uploadId), 'meta.json');
  }
  _normalizeChunkMeta(m) {
    if (!m || typeof m !== 'object') return null;
    const received = Array.isArray(m.received) ? m.received : [];
    m.received = received
      .map((r) => (typeof r === 'number' ? { partNumber: r, etag: null } : r))
      .filter((r) => r && Number.isInteger(r.partNumber))
      .sort((a, b) => a.partNumber - b.partNumber);
    if (m.expiresHours === undefined && m.expires !== undefined) m.expiresHours = m.expires;
    if (m.expiresHours === undefined) m.expiresHours = 0;
    if (!m.r2UploadId) m.r2UploadId = null;
    if (!m.storageKey) m.storageKey = null;
    if (!m.chunkSize) m.chunkSize = CHUNK_SIZE;
    if (!m.createdAt) m.createdAt = Date.now();
    return m;
  }
  _readChunkMeta(uploadId) {
    try {
      return this._normalizeChunkMeta(JSON.parse(fs.readFileSync(this._chunkMetaPath(uploadId), 'utf8')));
    } catch {
      return null;
    }
  }
  _writeChunkMeta(uploadId, meta) {
    fs.mkdirSync(this._chunkDir(uploadId), { recursive: true });
    fs.writeFileSync(this._chunkMetaPath(uploadId), JSON.stringify(meta));
  }
  async getChunkUpload(uploadId) {
    return this._readChunkMeta(uploadId);
  }
  async createChunkUpload(u) {
    return this._enqueue(() => {
      this._writeChunkMeta(u.uploadId, this._normalizeChunkMeta({ ...u }));
    });
  }
  async updateChunkUpload(uploadId, patch) {
    return this._enqueue(() => {
      const meta = this._readChunkMeta(uploadId);
      if (!meta) return;
      Object.assign(meta, patch);
      this._normalizeChunkMeta(meta);
      this._writeChunkMeta(uploadId, meta);
    });
  }
  async deleteChunkUpload(uploadId) {
    return this._enqueue(() => {
      try { fs.rmSync(this._chunkDir(uploadId), { recursive: true, force: true }); } catch {}
    });
  }
  async listStaleChunkUploads(before) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(this.chunksDir); } catch { return out; }
    for (const name of names) {
      const dir = path.join(this.chunksDir, name);
      try {
        const meta = this._readChunkMeta(name);
        const when = meta ? meta.createdAt : fs.statSync(dir).mtimeMs;
        if (when < before) out.push(meta || { uploadId: name, createdAt: when });
      } catch { /* ignore */ }
    }
    return out;
  }

  async writeChunkPart(uploadId, index, buffer) {
    return this._enqueue(() => {
      fs.mkdirSync(this._chunkDir(uploadId), { recursive: true });
      fs.writeFileSync(path.join(this._chunkDir(uploadId), String(index)), buffer);
      const meta = this._readChunkMeta(uploadId);
      if (meta) {
        if (!meta.received.some((r) => r.partNumber === index)) {
          meta.received.push({ partNumber: index, etag: null });
          meta.received.sort((a, b) => a.partNumber - b.partNumber);
        }
        this._writeChunkMeta(uploadId, meta);
      }
      return meta;
    });
  }
  async readChunkPart(uploadId, index) {
    try {
      return fs.readFileSync(path.join(this._chunkDir(uploadId), String(index)));
    } catch {
      return null;
    }
  }
  async chunkPartExists(uploadId, index) {
    try {
      return fs.existsSync(path.join(this._chunkDir(uploadId), String(index)));
    } catch {
      return false;
    }
  }
  async assembleChunks(uploadId, tmpPath) {
    const meta = this._readChunkMeta(uploadId);
    if (!meta) throw new Error('chunk meta missing');
    const ws = fs.createWriteStream(tmpPath);
    let total = 0;
    try {
      for (let i = 0; i < meta.total; i++) {
        const data = fs.readFileSync(path.join(this._chunkDir(uploadId), String(i)));
        total += data.length;
        await new Promise((resolve, reject) => ws.write(data, (e) => (e ? reject(e) : resolve())));
      }
      await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      try { ws.destroy(); } catch {}
      throw e;
    }
    return total;
  }
}
