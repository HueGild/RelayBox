// RelayBox core routes — WebDAV Server (v3.3.7, Station 9).
// Mounts the RelayBox virtual folder tree & multi-pool storage at /dav and /dav/*.
// Reuses existing API Tokens (scope = 'all') via HTTP Basic Auth (or Bearer),
// plus optional admin Basic Auth (admin + uploadPassword) with brute-force protection.
// Compatible with RaiDrive, Alist, Cyberduck, rclone, Windows Explorer, macOS Finder,
// VidHub, AfuseKt, nPlayer, Infuse.
// Pure Web APIs, zero Node built-in deps.

import {
  newId, safeName, extOf, kindOf, keyOf, folderIdOf, isExpired,
  parseRange, sha256Hex, MIN_FREE_BYTES, MIME, log,
} from '../lib/util.js';
import { isBlocked, clientIp, clientMeta, recordFailureWithAlert } from '../lib/auth.js';
import { buildPoolSummaries, resolveStorageForFile, resolveUploadTarget } from './pools.js';
import { moveFileToTrash, purgeFilePermanently } from './trash.js';
import { purgeEdgeCacheForFile } from '../lib/edge-cache.js';

const DEFAULT_WEBDAV_MAX_UPLOAD = 50 * 1024 * 1024; // 50MB single PUT limit
const DAV_ALLOW = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK';

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function htmlEscape(s) {
  return xmlEscape(s);
}

function encodeDavHref(segments, isCollection) {
  const encoded = segments.map((seg) => encodeURIComponent(seg)).join('/');
  if (!encoded) return '/dav/';
  return isCollection ? `/dav/${encoded}/` : `/dav/${encoded}`;
}

function httpDateOf(isoOrMs) {
  const d = isoOrMs ? new Date(isoOrMs) : new Date();
  return Number.isFinite(d.getTime()) ? d.toUTCString() : new Date().toUTCString();
}

function isoDateOf(isoOrMs) {
  const d = isoOrMs ? new Date(isoOrMs) : new Date();
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function parseDavSegments(pathname) {
  let rel = pathname;
  if (rel === '/dav' || rel === '/dav/') return { ok: true, segments: [] };
  if (rel.startsWith('/dav/')) rel = rel.slice('/dav/'.length);
  else if (rel.startsWith('/dav')) rel = rel.slice('/dav'.length);
  rel = rel.replace(/^\/+|\/+$/g, '');
  if (!rel) return { ok: true, segments: [] };
  const rawParts = rel.split('/');
  const segments = [];
  for (const raw of rawParts) {
    if (!raw || raw === '.') continue;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { ok: false, error: 'Invalid URI encoding' };
    }
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
      return { ok: false, error: 'Invalid path segment' };
    }
    segments.push(decoded);
  }
  return { ok: true, segments };
}

function decodeBasicAuth(b64) {
  try {
    const bin = atob(b64.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function unauthorizedResponse(extraHeaders = {}) {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="RelayBox WebDAV", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    },
  });
}

async function authenticateDav(c, deps) {
  const ip = clientIp(c, deps);
  if (await isBlocked(deps, ip)) {
    return { ok: false, status: 429, error: '尝试太频繁，10 分钟后再试' };
  }
  const authHeader = c.req.header('Authorization') || '';
  if (!authHeader) {
    return { ok: false, status: 401, missing: true };
  }

  let username = '';
  let secret = '';
  let isBearer = false;

  const basic = /^Basic\s+(.+)$/i.exec(authHeader);
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (basic) {
    const pair = decodeBasicAuth(basic[1]);
    if (!pair) {
      await recordFailureWithAlert(deps, ip, c, 'WebDAV 认证');
      return { ok: false, status: 401 };
    }
    username = pair.username;
    secret = pair.password;
  } else if (bearer) {
    secret = bearer[1].trim();
    isBearer = true;
  } else {
    return { ok: false, status: 401, missing: true };
  }

  if (!secret) {
    await recordFailureWithAlert(deps, ip, c, 'WebDAV 认证');
    return { ok: false, status: 401 };
  }

  // 1) Check API Token (preferred, revocable per device)
  const tokenHash = await sha256Hex(secret);
  const apiToken = await deps.meta.getApiTokenByHash(tokenHash);
  if (apiToken) {
    if (apiToken.scope !== 'all') {
      return {
        ok: false,
        status: 403,
        error: '该 API 密钥仅限上传，请使用「全功能 (all)」权限密钥挂载 WebDAV',
      };
    }
    await deps.meta.clearFailures(ip);
    deps.meta.touchApiToken(apiToken.id).catch(() => {});
    return { ok: true, principal: apiToken.prefix, token: apiToken };
  }

  // 2) Fallback: admin + uploadPassword via HTTP Basic Auth
  if (!isBearer && username === 'admin' && deps.config.uploadPassword && secret === deps.config.uploadPassword) {
    await deps.meta.clearFailures(ip);
    return { ok: true, principal: 'admin', token: null };
  }

  await recordFailureWithAlert(deps, ip, c, 'WebDAV 认证');
  return { ok: false, status: 401 };
}

/**
 * Resolve virtual path segments against RelayBox folders and active files.
 * Returns one of:
 *   { type: 'root', folderId: null, segments: [] }
 *   { type: 'folder', folder, parentId, segments }
 *   { type: 'file', file, parentId, segments }
 *   { type: 'not_found', parentId, name, segments }
 *   { type: 'missing_parent', segments }
 */
async function resolveDavNode(deps, segments) {
  if (!segments.length) {
    return { type: 'root', folderId: null, segments: [] };
  }
  const folders = await deps.meta.listFolders();
  let parentId = null;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = folders.find((fd) => (fd.parentId || null) === parentId && fd.name === seg);
    if (!next) return { type: 'missing_parent', segments };
    parentId = next.id;
  }

  const last = segments[segments.length - 1];
  const folder = folders.find((fd) => (fd.parentId || null) === parentId && fd.name === last);
  if (folder) {
    return { type: 'folder', folder, parentId, segments };
  }

  const filesInParent = await deps.meta.listFiles(parentId, { authed: true });
  const matches = filesInParent
    .filter((f) => !f.deletedAt && !isExpired(f) && f.name === last)
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  if (matches.length) {
    return { type: 'file', file: matches[0], parentId, segments };
  }

  return { type: 'not_found', parentId, name: last, segments };
}

function propfindEntryXml(href, { isCollection, displayName, size, contentType, lastModified, createdAt, etag }) {
  const props = [
    `<d:displayname>${xmlEscape(displayName)}</d:displayname>`,
    `<d:getlastmodified>${xmlEscape(httpDateOf(lastModified))}</d:getlastmodified>`,
    `<d:creationdate>${xmlEscape(isoDateOf(createdAt || lastModified))}</d:creationdate>`,
  ];
  if (isCollection) {
    props.push('<d:resourcetype><d:collection/></d:resourcetype>');
  } else {
    props.push('<d:resourcetype/>');
    props.push(`<d:getcontentlength>${Math.max(0, Number(size) || 0)}</d:getcontentlength>`);
    props.push(`<d:getcontenttype>${xmlEscape(contentType || 'application/octet-stream')}</d:getcontenttype>`);
    if (etag) props.push(`<d:getetag>${xmlEscape(etag)}</d:getetag>`);
  }
  return [
    '<d:response>',
    `<d:href>${xmlEscape(href)}</d:href>`,
    '<d:propstat>',
    `<d:prop>${props.join('')}</d:prop>`,
    '<d:status>HTTP/1.1 200 OK</d:status>',
    '</d:propstat>',
    '</d:response>',
  ].join('');
}

async function readBodyBytesWithLimit(req, maxBytes) {
  const cl = Number(req.header('Content-Length') || 0);
  if (Number.isFinite(cl) && cl > maxBytes) return { ok: false, tooLarge: true };
  const rawBody = req.raw && req.raw.body;
  if (!rawBody || typeof rawBody.getReader !== 'function') {
    const ab = await req.arrayBuffer();
    if (ab.byteLength > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, bytes: new Uint8Array(ab) };
  }
  const reader = rawBody.getReader();
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

async function resolveDefaultPoolTarget(deps) {
  const summary = await buildPoolSummaries(deps, [], { authed: false, includeAdminMeta: false });
  return resolveUploadTarget(deps, summary.defaultPoolId);
}

function parseDestinationSegments(destHeader, reqUrl) {
  if (!destHeader) return { ok: false, error: 'Missing Destination header' };
  let pathname = '';
  try {
    const u = new URL(destHeader.trim(), reqUrl);
    pathname = u.pathname;
  } catch {
    return { ok: false, error: 'Invalid Destination header' };
  }
  if (pathname !== '/dav' && !pathname.startsWith('/dav/')) {
    return { ok: false, error: 'Destination must be under /dav/' };
  }
  return parseDavSegments(pathname);
}

function isDescendantFolder(folders, ancestorId, targetId) {
  if (!targetId) return false;
  if (targetId === ancestorId) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = byId.get(targetId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    if (cur.id === ancestorId) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return false;
}

async function deleteFolderSubtree(deps, rootFolderId, permanent = false, c = null) {
  const folders = await deps.meta.listFolders();
  const subtreeIds = [];
  const collect = (fid) => {
    for (const child of folders) {
      if ((child.parentId || null) === fid) collect(child.id);
    }
    subtreeIds.push(fid);
  };
  collect(rootFolderId);

  const subtreeFiles = subtreeIds.length ? await deps.meta.listFilesInFolders(subtreeIds) : [];
  for (const f of subtreeFiles) {
    if (permanent) await purgeFilePermanently(deps, f, c);
    else await moveFileToTrash(deps, f, c);
  }
  // Delete folders bottom-up (children before parents)
  for (const fid of subtreeIds) {
    const share = await deps.meta.getShareByFolderId(fid);
    if (share) await deps.meta.deleteShare(share.token);
    await deps.meta.deleteFolder(fid);
  }
}

async function copyFileItem(deps, c, srcFile, targetFolderId, targetName, maxBytes) {
  const src = await resolveStorageForFile(deps, srcFile);
  if (!src.ok) return { ok: false, status: src.status || 503, error: src.error };

  const newFileId = newId();
  const cleanName = safeName(targetName);
  const ext = extOf(cleanName);
  const newKey = keyOf(newFileId, cleanName);
  const mime = MIME[ext] || 'application/octet-stream';
  const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;

  try {
    if (typeof src.driver.copy === 'function') {
      await src.driver.copy(srcFile.storageKey, newKey);
    } else {
      let res = await src.driver.get(srcFile.storageKey, { mode: 'proxy' });
      if (res && res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') || res.headers.get('Location');
        if (loc) res = await fetchFn(loc);
      }
      if (!res || !res.ok) return { ok: false, status: 502, error: '读取源文件失败' };
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) return { ok: false, status: 413, error: '文件过大' };
      await writeBytesToDriver(src.driver, newKey, new Uint8Array(ab), mime, fetchFn);
    }
  } catch (e) {
    log('webdav copy failed:', srcFile.name, e && e.message);
    return { ok: false, status: 500, error: '复制文件失败' };
  }

  const { uploadIp, uploadGeo } = clientMeta(c, deps);
  const fresh = {
    id: newFileId,
    name: cleanName,
    size: srcFile.size,
    ext,
    kind: kindOf(ext),
    visibility: srcFile.visibility || 'private',
    storage: srcFile.storage,
    storageKey: newKey,
    folderId: targetFolderId,
    expiresAt: srcFile.expiresAt || null,
    uploadedAt: new Date().toISOString(),
    downloads: 0,
    uploadIp,
    uploadGeo,
    width: srcFile.width || null,
    height: srcFile.height || null,
    poolId: srcFile.poolId || null,
  };
  await deps.meta.createFile(fresh);
  return { ok: true, file: fresh };
}

export function registerWebdav(app) {
  async function handleDav(c) {
    const deps = c.get('deps');
    const method = c.req.method.toUpperCase();
    const davHeaders = {
      DAV: '1, 2',
      Allow: DAV_ALLOW,
      'MS-Author-Via': 'DAV',
    };

    const auth = await authenticateDav(c, deps);
    if (!auth.ok) {
      if (auth.status === 429) {
        return new Response(auth.error || 'Too Many Requests', { status: 429 });
      }
      if (auth.status === 403) {
        return new Response(auth.error || 'Forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      return unauthorizedResponse(method === 'OPTIONS' ? davHeaders : {});
    }

    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: { ...davHeaders, 'Content-Length': '0' } });
    }

    const url = new URL(c.req.url);
    const parsedPath = parseDavSegments(url.pathname);
    if (!parsedPath.ok) {
      return new Response(parsedPath.error, { status: 400 });
    }
    const { segments } = parsedPath;
    const node = await resolveDavNode(deps, segments);

    // ---- PROPFIND ----
    if (method === 'PROPFIND') {
      if (node.type === 'not_found' || node.type === 'missing_parent') {
        return new Response('Not Found', { status: 404 });
      }
      const depthRaw = (c.req.header('Depth') || '1').trim().toLowerCase();
      const depth = depthRaw === '0' ? 0 : 1;
      const entries = [];

      if (node.type === 'file') {
        const f = node.file;
        entries.push(propfindEntryXml(encodeDavHref(segments, false), {
          isCollection: false,
          displayName: f.name,
          size: f.size,
          contentType: MIME[f.ext] || 'application/octet-stream',
          lastModified: f.uploadedAt,
          createdAt: f.uploadedAt,
          etag: `"${f.id}-${f.size}"`,
        }));
      } else {
        const isRoot = node.type === 'root';
        const folderId = isRoot ? null : node.folder.id;
        entries.push(propfindEntryXml(encodeDavHref(segments, true), {
          isCollection: true,
          displayName: isRoot ? 'RelayBox' : node.folder.name,
          lastModified: isRoot ? Date.now() : node.folder.createdAt,
          createdAt: isRoot ? Date.now() : node.folder.createdAt,
        }));

        if (depth >= 1) {
          const [folders, files] = await Promise.all([
            deps.meta.listFolders(),
            deps.meta.listFiles(folderId, { authed: true }),
          ]);
          const childFolders = folders
            .filter((fd) => (fd.parentId || null) === folderId)
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const fd of childFolders) {
            entries.push(propfindEntryXml(encodeDavHref([...segments, fd.name], true), {
              isCollection: true,
              displayName: fd.name,
              lastModified: fd.createdAt,
              createdAt: fd.createdAt,
            }));
          }
          const seenNames = new Set(childFolders.map((fd) => fd.name));
          const sortedFiles = files
            .filter((f) => !f.deletedAt && !isExpired(f))
            .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
          for (const f of sortedFiles) {
            if (seenNames.has(f.name)) continue;
            seenNames.add(f.name);
            entries.push(propfindEntryXml(encodeDavHref([...segments, f.name], false), {
              isCollection: false,
              displayName: f.name,
              size: f.size,
              contentType: MIME[f.ext] || 'application/octet-stream',
              lastModified: f.uploadedAt,
              createdAt: f.uploadedAt,
              etag: `"${f.id}-${f.size}"`,
            }));
          }
        }
      }

      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`;
      return new Response(xml, {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 2' },
      });
    }

    // ---- HEAD / GET ----
    if (method === 'HEAD' || method === 'GET') {
      if (node.type === 'not_found' || node.type === 'missing_parent') {
        return new Response('Not Found', { status: 404 });
      }
      if (node.type === 'root' || node.type === 'folder') {
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'httpd/unix-directory', DAV: '1, 2' },
          });
        }
        const folderId = node.type === 'root' ? null : node.folder.id;
        const [folders, files] = await Promise.all([
          deps.meta.listFolders(),
          deps.meta.listFiles(folderId, { authed: true }),
        ]);
        const sub = folders.filter((fd) => (fd.parentId || null) === folderId);
        const itemsHtml = [
          ...(segments.length ? [`<li><a href="${encodeDavHref(segments.slice(0, -1), true)}">../</a></li>`] : []),
          ...sub.map((fd) => `<li><a href="${encodeDavHref([...segments, fd.name], true)}">${htmlEscape(fd.name)}/</a></li>`),
          ...files.filter((f) => !f.deletedAt && !isExpired(f)).map((f) => `<li><a href="${encodeDavHref([...segments, f.name], false)}">${htmlEscape(f.name)}</a> (${f.size} B)</li>`),
        ].join('');
        const title = segments.length ? '/' + segments.join('/') : '/';
        const html = `<!doctype html><meta charset="utf-8"><title>RelayBox WebDAV ${htmlEscape(title)}</title><h1>RelayBox WebDAV ${htmlEscape(title)}</h1><ul>${itemsHtml}</ul>`;
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      const item = node.file;
      const mime = MIME[item.ext] || 'application/octet-stream';
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(item.size || 0),
            'Accept-Ranges': 'bytes',
            'Last-Modified': httpDateOf(item.uploadedAt),
            ETag: `"${item.id}-${item.size}"`,
          },
        });
      }

      const resolved = await resolveStorageForFile(deps, item);
      if (!resolved.ok) return new Response(resolved.error || 'Storage unavailable', { status: resolved.status || 503 });
      const range = parseRange(c.req.header('Range'));
      const res = await resolved.driver.get(item.storageKey, {
        mode: resolved.driver.proxySupported ? 'proxy' : resolved.mode,
        start: range ? range.start : undefined,
        end: range ? range.end : undefined,
        contentType: mime,
        disposition: `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        cacheControl: 'private, no-store',
      });
      if (!res) return new Response('Not Found', { status: 404 });
      return res;
    }

    // ---- MKCOL (Create folder) ----
    if (method === 'MKCOL') {
      if (node.type === 'missing_parent') return new Response('Conflict: parent missing', { status: 409 });
      if (node.type === 'root' || node.type === 'folder' || node.type === 'file') {
        return new Response('Method Not Allowed: already exists', { status: 405 });
      }
      const clean = safeName(node.name);
      if (!clean || clean === 'file') return new Response('Bad folder name', { status: 400 });
      const folder = {
        id: newId(),
        name: clean,
        parentId: node.parentId,
        createdAt: new Date().toISOString(),
      };
      await deps.meta.createFolder(folder);
      log('webdav MKCOL:', segments.join('/'));
      return new Response(null, { status: 201 });
    }

    // ---- PUT (Upload / Overwrite file; supports 0-byte placeholders for Finder/Windows) ----
    if (method === 'PUT') {
      if (node.type === 'missing_parent') return new Response('Conflict: parent missing', { status: 409 });
      if (node.type === 'root' || node.type === 'folder') {
        return new Response('Method Not Allowed: target is a directory', { status: 405 });
      }
      const cfgLimit = Number(deps.config.webdavMaxUploadBytes) > 0
        ? Number(deps.config.webdavMaxUploadBytes)
        : DEFAULT_WEBDAV_MAX_UPLOAD;
      const siteMax = Number(deps.config.maxUploadSize) > 0 ? Number(deps.config.maxUploadSize) : cfgLimit;
      const maxBytes = Math.min(cfgLimit, siteMax);

      const read = await readBodyBytesWithLimit(c.req, maxBytes);
      if (!read.ok && read.tooLarge) {
        return new Response(`Payload Too Large (max ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`, { status: 413 });
      }
      const bytes = read.bytes;
      const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;

      if (node.type === 'file') {
        const existing = node.file;
        const resolved = await resolveStorageForFile(deps, existing);
        if (!resolved.ok) return new Response(resolved.error || 'Storage unavailable', { status: resolved.status || 503 });
        if (resolved.storageType === 'local' && deps.local.freeBytes() < MIN_FREE_BYTES) {
          return new Response('Insufficient Storage', { status: 507 });
        }
        const mime = MIME[existing.ext] || (c.req.header('Content-Type') || '').split(';')[0].trim() || 'application/octet-stream';
        try {
          await writeBytesToDriver(resolved.driver, existing.storageKey, bytes, mime, fetchFn);
        } catch (e) {
          log('webdav PUT overwrite failed:', existing.name, e && e.message);
          return new Response('Storage write failed', { status: 500 });
        }
        const updated = await deps.meta.updateFile(existing.id, {
          size: bytes.byteLength,
          uploadedAt: new Date().toISOString(),
        });
        await purgeEdgeCacheForFile(deps, c, existing.id);
        log('webdav PUT overwrite:', segments.join('/'), bytes.byteLength + 'B');
        return new Response(null, {
          status: 204,
          headers: { ETag: `"${(updated || existing).id}-${bytes.byteLength}"` },
        });
      }

      const target = await resolveDefaultPoolTarget(deps);
      if (!target.ok) return new Response(target.error || 'Storage unavailable', { status: target.status || 503 });
      if (target.storage === 'local' && deps.local.freeBytes() < MIN_FREE_BYTES) {
        return new Response('Insufficient Storage', { status: 507 });
      }

      const filename = safeName(node.name);
      const ext = extOf(filename);
      const mime = MIME[ext] || (c.req.header('Content-Type') || '').split(';')[0].trim() || 'application/octet-stream';
      const id = newId();
      const key = keyOf(id, filename);
      try {
        await writeBytesToDriver(target.driver, key, bytes, mime, fetchFn);
      } catch (e) {
        log('webdav PUT failed:', filename, e && e.message);
        return new Response('Storage write failed', { status: 500 });
      }

      const visHdr = (c.req.header('X-Visibility') || '').trim().toLowerCase();
      const { uploadIp, uploadGeo } = clientMeta(c, deps);
      const item = {
        id,
        name: filename,
        size: bytes.byteLength,
        ext,
        kind: kindOf(ext),
        visibility: visHdr === 'public' ? 'public' : 'private',
        storage: target.storage,
        storageKey: key,
        folderId: node.parentId,
        expiresAt: null,
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
        try { await target.driver.delete(key); } catch {}
        return new Response('Metadata save failed', { status: 500 });
      }
      log('webdav PUT created:', segments.join('/'), bytes.byteLength + 'B');
      return new Response(null, {
        status: 201,
        headers: { ETag: `"${item.id}-${item.size}"` },
      });
    }

    // ---- DELETE (File -> 7-day trash; Folder -> recursive delete with files trashed) ----
    if (method === 'DELETE') {
      if (node.type === 'root') return new Response('Cannot delete root', { status: 403 });
      if (node.type === 'not_found' || node.type === 'missing_parent') {
        return new Response('Not Found', { status: 404 });
      }
      const permanent = url.searchParams.get('permanent') === '1';
      if (node.type === 'file') {
        if (permanent) await purgeFilePermanently(deps, node.file, c);
        else await moveFileToTrash(deps, node.file, c);
        log('webdav DELETE file:', segments.join('/'));
        return new Response(null, { status: 204 });
      }
      await deleteFolderSubtree(deps, node.folder.id, permanent, c);
      log('webdav DELETE folder:', segments.join('/'));
      return new Response(null, { status: 204 });
    }

    // ---- MOVE ----
    if (method === 'MOVE') {
      if (node.type === 'root') return new Response('Cannot move root', { status: 403 });
      if (node.type === 'not_found' || node.type === 'missing_parent') {
        return new Response('Not Found', { status: 404 });
      }
      const dstParsed = parseDestinationSegments(c.req.header('Destination'), c.req.url);
      if (!dstParsed.ok) return new Response(dstParsed.error, { status: 400 });
      if (!dstParsed.segments.length) return new Response('Cannot overwrite root', { status: 403 });

      const dstNode = await resolveDavNode(deps, dstParsed.segments);
      if (dstNode.type === 'missing_parent') return new Response('Conflict: destination parent missing', { status: 409 });

      const overwrite = (c.req.header('Overwrite') || 'T').trim().toUpperCase() !== 'F';
      let overwritten = false;

      if (node.type === 'file') {
        if (dstNode.type === 'folder') return new Response('Cannot overwrite folder with file', { status: 409 });
        if (dstNode.type === 'file') {
          if (dstNode.file.id === node.file.id) return new Response(null, { status: 204 });
          if (!overwrite) return new Response('Precondition Failed', { status: 412 });
          await moveFileToTrash(deps, dstNode.file, c);
          overwritten = true;
        }
        const targetParentId = dstNode.parentId;
        const targetName = safeName(dstNode.type === 'not_found' ? dstNode.name : dstNode.file.name);
        if (!targetName || targetName === 'file') return new Response('Invalid filename', { status: 400 });
        const patch = { folderId: targetParentId };
        if (targetName !== node.file.name) {
          const newKey = keyOf(node.file.id, targetName);
          const resolved = await resolveStorageForFile(deps, node.file);
          if (!resolved.ok) return new Response(resolved.error || 'Storage unavailable', { status: resolved.status || 503 });
          try {
            await resolved.driver.rename(node.file.storageKey, newKey);
          } catch (e) {
            log('webdav MOVE rename failed:', e && e.message);
            return new Response('Rename failed', { status: 500 });
          }
          patch.name = targetName;
          patch.ext = extOf(targetName);
          patch.kind = kindOf(patch.ext);
          patch.storageKey = newKey;
        }
        await deps.meta.updateFile(node.file.id, patch);
      await purgeEdgeCacheForFile(deps, c, node.file.id);
        log('webdav MOVE file:', segments.join('/'), '->', dstParsed.segments.join('/'));
        return new Response(null, { status: overwritten ? 204 : 201 });
      }

      // Moving a folder
      const folders = await deps.meta.listFolders();
      if (dstNode.type === 'folder') {
        if (dstNode.folder.id === node.folder.id) return new Response(null, { status: 204 });
        if (!overwrite) return new Response('Precondition Failed', { status: 412 });
        return new Response('Conflict: destination folder exists', { status: 409 });
      }
      if (dstNode.type === 'file') {
        if (!overwrite) return new Response('Precondition Failed', { status: 412 });
        await moveFileToTrash(deps, dstNode.file, c);
        overwritten = true;
      }
      if (isDescendantFolder(folders, node.folder.id, dstNode.parentId)) {
        return new Response('Conflict: cannot move folder into itself', { status: 409 });
      }
      const nextName = safeName(dstNode.type === 'not_found' ? dstNode.name : dstParsed.segments[dstParsed.segments.length - 1]);
      if (!nextName || nextName === 'file') return new Response('Invalid folder name', { status: 400 });
      await deps.meta.updateFolder(node.folder.id, { name: nextName, parentId: dstNode.parentId });
      log('webdav MOVE folder:', segments.join('/'), '->', dstParsed.segments.join('/'));
      return new Response(null, { status: overwritten ? 204 : 201 });
    }

    // ---- COPY ----
    if (method === 'COPY') {
      if (node.type === 'root') return new Response('Cannot copy root', { status: 403 });
      if (node.type === 'not_found' || node.type === 'missing_parent') {
        return new Response('Not Found', { status: 404 });
      }
      if (node.type === 'folder') {
        return new Response('Folder copy not implemented', { status: 501 });
      }
      const dstParsed = parseDestinationSegments(c.req.header('Destination'), c.req.url);
      if (!dstParsed.ok) return new Response(dstParsed.error, { status: 400 });
      if (!dstParsed.segments.length) return new Response('Cannot overwrite root', { status: 403 });
      const dstNode = await resolveDavNode(deps, dstParsed.segments);
      if (dstNode.type === 'missing_parent') return new Response('Conflict: destination parent missing', { status: 409 });
      if (dstNode.type === 'folder') return new Response('Cannot overwrite folder with file', { status: 409 });

      const overwrite = (c.req.header('Overwrite') || 'T').trim().toUpperCase() !== 'F';
      let overwritten = false;
      if (dstNode.type === 'file') {
        if (dstNode.file.id === node.file.id) return new Response(null, { status: 204 });
        if (!overwrite) return new Response('Precondition Failed', { status: 412 });
        await moveFileToTrash(deps, dstNode.file, c);
        overwritten = true;
      }

      const cfgLimit = Number(deps.config.webdavMaxUploadBytes) > 0
        ? Number(deps.config.webdavMaxUploadBytes)
        : DEFAULT_WEBDAV_MAX_UPLOAD;
      const targetName = dstNode.type === 'not_found' ? dstNode.name : dstNode.file.name;
      const copied = await copyFileItem(deps, c, node.file, dstNode.parentId, targetName, cfgLimit);
      if (!copied.ok) return new Response(copied.error || 'Copy failed', { status: copied.status || 500 });
      log('webdav COPY file:', segments.join('/'), '->', dstParsed.segments.join('/'));
      return new Response(null, { status: overwritten ? 204 : 201 });
    }

    // ---- LOCK / UNLOCK (lightweight RFC 4918 class-2 stub for Finder & Windows Explorer) ----
    if (method === 'LOCK') {
      const token = `opaquelocktoken:${newId()}`;
      const href = encodeDavHref(segments, node.type === 'root' || node.type === 'folder');
      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:owner><d:href>${xmlEscape(auth.principal || 'admin')}</d:href></d:owner><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${xmlEscape(token)}</d:href></d:locktoken><d:lockroot><d:href>${xmlEscape(href)}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`;
      return new Response(xml, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Lock-Token': `<${token}>`,
        },
      });
    }

    if (method === 'UNLOCK') {
      return new Response(null, { status: 204 });
    }

    return new Response('Method Not Allowed', { status: 405, headers: { Allow: DAV_ALLOW } });
  }

  app.all('/dav', handleDav);
  app.all('/dav/*', handleDav);
}
