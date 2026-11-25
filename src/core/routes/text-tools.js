// RelayBox core routes — Text/Code Pastebin + Online Text Editor (v3.3.5).
// Pure Web APIs (TextEncoder / TextDecoder / fetch). Zero Node built-in deps.
// Covers:
//   POST /api/paste             — quick text/code snippet upload + optional 5-char pickup share
//   GET  /api/files/:id/content — admin read UTF-8 text content (no-store, multi-pool aware)
//   PUT  /api/files/:id/content — admin overwrite UTF-8 text content in-place + update size

import {
  newId, newToken, newPickupCode, safeName, extOf, kindOf, keyOf,
  parseExpiresHours, expiresAtOf, isExpired, MIN_FREE_BYTES, MIME, log,
} from '../lib/util.js';
import { isAuthed, authOrPassword, authFail, clientMeta } from '../lib/auth.js';
import { resolveUploadTarget, resolveStorageForFile } from './pools.js';

const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024; // 1MB UTF-8 text limit

export const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yaml', '.yml', '.toml',
  '.ini', '.conf', '.cfg', '.env', '.log', '.sh', '.bash', '.zsh', '.bat', '.ps1',
  '.py', '.rb', '.php', '.sql', '.csv', '.c', '.cpp', '.h', '.hpp', '.java', '.kt',
  '.go', '.rs', '.swift', '.vue', '.svelte',
]);

const LANG_TO_EXT = {
  txt: '.txt', text: '.txt', plain: '.txt',
  md: '.md', markdown: '.md',
  json: '.json',
  js: '.js', javascript: '.js',
  ts: '.ts', typescript: '.ts',
  py: '.py', python: '.py',
  html: '.html', htm: '.html',
  css: '.css', scss: '.scss',
  sh: '.sh', bash: '.sh', shell: '.sh',
  sql: '.sql',
  yaml: '.yaml', yml: '.yml', toml: '.toml',
  xml: '.xml', csv: '.csv', ini: '.ini', conf: '.conf', env: '.env', log: '.log',
  go: '.go', rs: '.rs', rust: '.rs', java: '.java',
  c: '.c', cpp: '.cpp', h: '.h', php: '.php', rb: '.rb',
};

const TEXT_MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.less': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
};

export function isEditableTextFile(item) {
  if (!item || !item.name) return false;
  const ext = (item.ext || extOf(item.name) || '').toLowerCase();
  return TEXT_EXTS.has(ext);
}

function textMimeOf(ext) {
  const e = String(ext || '').toLowerCase();
  return TEXT_MIME[e] || MIME[e] || 'text/plain; charset=utf-8';
}

function maxTextBytesOf(deps) {
  const cfg = Number(deps && deps.config && deps.config.textMaxBytes);
  return (Number.isFinite(cfg) && cfg > 0) ? Math.floor(cfg) : DEFAULT_MAX_TEXT_BYTES;
}

/** Safe JSON body reader supporting payloads up to ~2x text limit (util.readJsonBody is capped at 4KB). */
async function readLargeJsonBody(c, maxBytes) {
  const limit = Math.max(64 * 1024, maxBytes * 2 + 16384);
  const cl = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(cl) && cl > limit) return { ok: false, tooLarge: true };
  let raw = '';
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, invalid: true };
  }
  if (!raw) return { ok: true, data: {} };
  if (raw.length > limit) return { ok: false, tooLarge: true };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, invalid: true };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, invalid: true };
  }
}

async function generateUniquePickupCode(deps) {
  for (let i = 0; i < 3; i++) {
    const code = newPickupCode();
    const existing = await deps.meta.getShareByPickupCode(code);
    if (!existing) return code;
  }
  return null;
}

async function writeBytesToDriver(driver, key, bytes, mime, fetchFn) {
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

async function readStreamBytesWithLimit(res, maxBytes) {
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

async function readTextFromDriver(driver, key, fetchFn, maxBytes) {
  let res = await driver.get(key, { mode: 'proxy' });
  if (!res) return { ok: false, status: 404, error: '文件内容不存在' };
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || res.headers.get('Location');
    if (!loc) return { ok: false, status: 502, error: '无法读取文件内容' };
    res = await fetchFn(loc);
  }
  if (res.status === 404) return { ok: false, status: 404, error: '文件内容不存在' };
  if (!res.ok) return { ok: false, status: 502, error: `读取文件内容失败（HTTP ${res.status}）` };
  const cl = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(cl) && cl > maxBytes) {
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
    return { ok: false, status: 413, error: `文件过大，暂不支持在线编辑（最大 ${(maxBytes / 1024).toFixed(0)} KB）` };
  }
  const read = await readStreamBytesWithLimit(res, maxBytes);
  if (!read.ok && read.tooLarge) {
    return { ok: false, status: 413, error: `文件过大，暂不支持在线编辑（最大 ${(maxBytes / 1024).toFixed(0)} KB）` };
  }
  const content = new TextDecoder('utf-8').decode(read.bytes);
  return { ok: true, content, size: read.bytes.byteLength };
}

function resolvePasteFilename(rawName, lang) {
  const langKey = String(lang || 'txt').trim().toLowerCase().replace(/^\./, '');
  const langExt = LANG_TO_EXT[langKey] || '.txt';
  const trimmed = String(rawName || '').trim();
  if (!trimmed) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    return safeName(`paste_${stamp}${langExt}`);
  }
  let name = safeName(trimmed);
  const existingExt = extOf(name);
  if (!existingExt) {
    name = safeName(name + langExt);
  } else if (!TEXT_EXTS.has(existingExt)) {
    name = safeName(name + langExt);
  }
  return name;
}

export function registerTextTools(app) {
  // 1) 轻量文字 / 代码快传（Pastebin + 5 位短取件码）
  app.post('/api/paste', async (c) => {
    const deps = c.get('deps');
    const maxBytes = maxTextBytesOf(deps);
    const parsed = await readLargeJsonBody(c, maxBytes);
    if (!parsed.ok) {
      if (parsed.tooLarge) {
        return c.json({ ok: false, error: `文本内容超过上限（最大 ${(maxBytes / 1024).toFixed(0)} KB）` }, 413);
      }
      return c.json({ ok: false, error: '请求格式不正确' }, 400);
    }
    const body = parsed.data;
    const auth = await authOrPassword(c, deps, body.password || '');
    if (auth !== 'ok') return authFail(c, auth);

    if (typeof body.content !== 'string') {
      return c.json({ ok: false, error: '请输入要保存的文字或代码内容' }, 400);
    }
    const bytes = new TextEncoder().encode(body.content);
    if (bytes.byteLength <= 0) {
      return c.json({ ok: false, error: '文本内容不能为空' }, 400);
    }
    if (bytes.byteLength > maxBytes) {
      return c.json({ ok: false, error: `文本内容超过上限（最大 ${(maxBytes / 1024).toFixed(0)} KB）` }, 413);
    }

    let folderId = (typeof body.folderId === 'string' && body.folderId.trim()) ? body.folderId.trim() : null;
    if (folderId) {
      const fd = await deps.meta.getFolder(folderId);
      if (!fd) return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
    }

    const target = await resolveUploadTarget(deps, body.poolId, body.storage);
    if (!target.ok) return c.json({ ok: false, error: target.error }, target.status || 400);
    if (target.storage === 'local' && deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }

    const filename = resolvePasteFilename(body.name, body.lang);
    const ext = extOf(filename) || '.txt';
    const mime = textMimeOf(ext);
    const id = newId();
    const key = keyOf(id, filename);
    const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;

    try {
      await writeBytesToDriver(target.driver, key, bytes, mime, fetchFn);
    } catch (e) {
      log('paste write failed:', e && e.message);
      return c.json({ ok: false, error: '写入存储池失败：' + ((e && e.message) || '未知错误') }, 500);
    }

    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const item = {
      id,
      name: filename,
      size: bytes.byteLength,
      ext,
      kind: kindOf(ext),
      visibility: body.visibility === 'public' ? 'public' : 'private',
      storage: target.storage,
      storageKey: key,
      folderId,
      expiresAt: expiresAtOf(parseExpiresHours(body.expires || 0)),
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      uploadIp,
      uploadGeo,
      width: null,
      height: null,
      poolId: target.poolId || null,
    };

    try {
      await deps.meta.createFile(item);
    } catch (e) {
      log('paste meta save failed:', e && e.message);
      try { await target.driver.delete(key); } catch {}
      return c.json({ ok: false, error: '保存文件记录失败' }, 500);
    }

    let share = null;
    if (body.createShare !== false) {
      const code = (typeof body.code === 'string') ? body.code.trim().slice(0, 32) : '';
      const hasMaxDl = typeof body.maxDownloads === 'number'
        && Number.isFinite(body.maxDownloads) && body.maxDownloads >= 0;
      const maxDownloads = hasMaxDl ? Math.floor(body.maxDownloads) : (body.burn === true ? 1 : 0);
      const burn = maxDownloads === 1;
      const pickupCode = await generateUniquePickupCode(deps);
      const fresh = {
        token: newToken(),
        fileId: item.id,
        code,
        burn,
        maxDownloads,
        usedDownloads: 0,
        pickupCode,
        createdAt: new Date().toISOString(),
      };
      try {
        share = await deps.meta.createShare(fresh);
      } catch (e) {
        if (/UNIQUE/i.test((e && e.message) || '')) {
          const retryCode = await generateUniquePickupCode(deps);
          share = await deps.meta.createShare({ ...fresh, pickupCode: retryCode });
        } else {
          log('paste share create failed:', e && e.message);
        }
      }
    }

    const poolName = target.pool ? target.pool.name : (target.storage === 'local' ? '本地磁盘' : '内置 R2');
    log('pasted:', filename, bytes.byteLength + 'B ->', poolName, share ? `(pickup ${share.pickupCode || '-'})` : '');
    return c.json({
      ok: true,
      file: { ...item, poolName, shareToken: share ? share.token : null },
      share: share ? {
        token: share.token,
        code: share.code || null,
        burn: !!share.burn,
        pickupCode: share.pickupCode || null,
        maxDownloads: typeof share.maxDownloads === 'number' ? share.maxDownloads : 0,
        usedDownloads: typeof share.usedDownloads === 'number' ? share.usedDownloads : 0,
      } : null,
    });
  });

  // 2) 管理员读取文本 / 代码文件内容（无缓存，跨存储池通用）
  app.get('/api/files/:id/content', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt || isExpired(item)) return c.json({ ok: false, error: '文件不存在或已过期' }, 404);
    if (!isEditableTextFile(item)) {
      return c.json({ ok: false, error: '该文件类型暂不支持在线编辑' }, 400);
    }
    const maxBytes = maxTextBytesOf(deps);
    if (item.size > maxBytes) {
      return c.json({ ok: false, error: `文件过大，暂不支持在线编辑（最大 ${(maxBytes / 1024).toFixed(0)} KB）` }, 413);
    }
    const resolved = await resolveStorageForFile(deps, item);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 503);
    const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
    try {
      const read = await readTextFromDriver(resolved.driver, item.storageKey, fetchFn, maxBytes);
      if (!read.ok) return c.json({ ok: false, error: read.error }, read.status || 500);
      const poolName = resolved.pool ? resolved.pool.name : (resolved.storageType === 'local' ? '本地磁盘' : '内置 R2');
      c.header('Cache-Control', 'no-store');
      return c.json({
        ok: true,
        id: item.id,
        name: item.name,
        ext: item.ext,
        size: read.size,
        poolName,
        content: read.content,
      });
    } catch (e) {
      log('read text content failed:', e && e.message);
      return c.json({ ok: false, error: '读取文件内容失败' }, 500);
    }
  });

  // 3) 管理员在线编辑并覆盖保存文本 / 代码文件内容
  app.put('/api/files/:id/content', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const item = await deps.meta.getFile(id);
    if (!item || item.deletedAt || isExpired(item)) return c.json({ ok: false, error: '文件不存在或已过期' }, 404);
    if (!isEditableTextFile(item)) {
      return c.json({ ok: false, error: '该文件类型暂不支持在线编辑' }, 400);
    }

    const maxBytes = maxTextBytesOf(deps);
    const parsed = await readLargeJsonBody(c, maxBytes);
    if (!parsed.ok) {
      if (parsed.tooLarge) {
        return c.json({ ok: false, error: `文本内容超过上限（最大 ${(maxBytes / 1024).toFixed(0)} KB）` }, 413);
      }
      return c.json({ ok: false, error: '请求格式不正确' }, 400);
    }
    const { content } = parsed.data;
    if (typeof content !== 'string') {
      return c.json({ ok: false, error: '请提供有效的文本内容' }, 400);
    }
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > maxBytes) {
      return c.json({ ok: false, error: `文本内容超过上限（最大 ${(maxBytes / 1024).toFixed(0)} KB）` }, 413);
    }

    const resolved = await resolveStorageForFile(deps, item);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status || 503);
    if (resolved.storageType === 'local' && deps.local.freeBytes() < MIN_FREE_BYTES) {
      return c.json({ ok: false, error: '磁盘空间不足' }, 507);
    }

    const mime = textMimeOf(item.ext);
    const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
    try {
      await writeBytesToDriver(resolved.driver, item.storageKey, bytes, mime, fetchFn);
    } catch (e) {
      log('save text content failed:', e && e.message);
      return c.json({ ok: false, error: '保存文件失败：' + ((e && e.message) || '未知错误') }, 500);
    }

    const updated = await deps.meta.updateFile(id, { size: bytes.byteLength });
    log('edited text file:', item.name, bytes.byteLength + 'B');
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true, file: updated || { ...item, size: bytes.byteLength } });
  });
}
