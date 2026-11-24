// RelayBox core lib — pure helpers (Web-standard only, zero Node deps).
// Behaviour mirrors v2.8.4 server.js exactly; the plan's contract defers to it
// wherever the two disagree.

export const CHUNK_SIZE = 5 * 1024 * 1024;           // 分片上传：一片 5MB
export const CHUNK_TTL_MS = 24 * 3600 * 1000;        // 分片 24 小时内没拼完就清掉
export const R2_FREE_BYTES = 10 * 1024 * 1024 * 1024; // R2 免费额度 10GB
export const MIN_FREE_BYTES = 500 * 1024 * 1024;     // 磁盘剩余少于 500MB 时拒绝上传
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;  // 管理员登录 7 天
export const FAIL_WINDOW_MS = 10 * 60 * 1000;        // 密码试错窗口 10 分钟
export const FAIL_LIMIT = 5;                         // 10 分钟内错 5 次就封
export const FAIL_BLOCK_MS = 10 * 60 * 1000;         // 封 10 分钟
export const MAX_JSON_BODY = 4096;                   // JSON 请求体上限（现状 readJsonBody 的 guard）

export const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage', '.iso': 'application/x-iso9660-image',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg']);

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** File extension, lower-cased (path.extname equivalent, no node:path). */
export function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i).toLowerCase() : '';
}

export function kindOf(ext) {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

/** Sanitize a file/folder name (path.basename + illegal-char strip, no node:path). */
export function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[/\\?%*:|"<>]/g, '_').trim() || 'file';
  if (base.length <= 120) return base;
  const ext = extOf(base);
  if (ext && ext.length < 120) return base.slice(0, 120 - ext.length) + ext;
  return base.slice(0, 120);
}

/** Flat physical key, v2.8.4 format (kept for VPS compat; see storageKey notes). */
export function keyOf(id, name) {
  return `${id}_${name}`;
}

/** Parse positive integer media dimension (width/height, 1..65535); null otherwise. */
export function parseDim(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return (i >= 1 && i <= 65535) ? i : null;
}

// 有效期：只认 0（永久）/ 24 / 168 小时三档，其余一律按永久算。
export function parseExpiresHours(v) {
  const n = Number(v);
  return (n === 24 || n === 168) ? n : 0;
}
export function expiresAtOf(hours) {
  return hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null;
}
export function isExpired(item) {
  return !!(item.expiresAt && Date.now() > new Date(item.expiresAt).getTime());
}

// 文件所属文件夹：老数据没有 folderId 的一律算根目录（null）。
export function folderIdOf(f) {
  return (f && typeof f.folderId === 'string' && f.folderId) ? f.folderId : null;
}
// 面包屑：从根到该文件夹的链，id 不存在时只返回根。
export function folderPath(folders, folderId) {
  const chain = [{ id: null, name: '根目录' }];
  if (!folderId) return chain;
  const byId = new Map(folders.map((f) => [f.id, f]));
  if (!byId.has(folderId)) return chain;
  const stack = [];
  let cur = byId.get(folderId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    stack.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain.concat(stack);
}
// 未登录访客能不能看到这个文件夹：里面（递归）至少有一个公开且未过期的文件。
export function folderVisibleToGuest(folders, files, folderId) {
  for (const f of files) {
    if (folderIdOf(f) === folderId && !isExpired(f) && f.visibility === 'public') return true;
  }
  for (const k of folders) {
    if ((k.parentId || null) === folderId && folderVisibleToGuest(folders, files, k.id)) return true;
  }
  return false;
}

/** Web Crypto id: same shape as v2.8.4 (Date.now base36 + 6 hex chars). */
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function newId() {
  return Date.now().toString(36) + randomHex(3);
}
/** Share token: 9 random bytes, base64url (12 chars, same as v2.8.4). */
export function newToken() {
  const arr = new Uint8Array(9);
  crypto.getRandomValues(arr);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Admin session token: 24 random bytes, hex (same shape as v2.8.4). */
export function newSessionToken() {
  return randomHex(24);
}

/** 5 位短取件码字符集：31 个无歧义字符（去 0/O/1/I/L），5 位约 2860 万种组合。 */
export const PICKUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** 生成一个 5 位短取件码（Web Crypto 随机）。 */
export function newPickupCode() {
  const arr = new Uint8Array(5);
  crypto.getRandomValues(arr);
  let out = '';
  for (const b of arr) out += PICKUP_CODE_ALPHABET[b % PICKUP_CODE_ALPHABET.length];
  return out;
}

/** API Token 明文：`rbx_` + 32 位随机 hex。明文只在创建时返回一次，入库只存 SHA-256。 */
export function newApiToken() {
  return 'rbx_' + randomHex(16);
}

/** Web Crypto SHA-256，返回小写 hex（64 字符）。零 Node 依赖，Node 与 Workers 通用。 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse a Cookie header into an object (no decode errors). */
export function parseCookies(header) {
  const out = {};
  const h = header || '';
  h.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
  });
  return out;
}

/**
 * Safe JSON body read for Hono: returns {} on empty/invalid/oversize body.
 * Never call this on routes that read the raw body themselves
 * (multipart upload, chunk upload, thumb upload).
 */
export async function readJsonBody(c) {
  try {
    const text = await c.req.text();
    if (!text || text.length > MAX_JSON_BODY) return {};
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

/** Parse a Range header (`bytes=start-end`) into {start, end} (may be nulls). */
export function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  return {
    start: m[1] === '' ? null : parseInt(m[1], 10),
    end: m[2] === '' ? null : parseInt(m[2], 10),
  };
}
