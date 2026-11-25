// RelayBox core routes — thumbnails (upload / view).
// Supports both image and video thumbnails (v3.1.5) and optionally backfills
// media width/height from X-Media-Width / X-Media-Height headers.

import { isExpired, parseDim } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail } from '../lib/auth.js';

function detectThumbMime(buf) {
  if (!buf || buf.byteLength < 12) return 'image/jpeg';
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  return 'image/jpeg';
}

export function registerThumbs(app) {
  // 缩略图上传：浏览器在图片或视频上传成功后用 canvas 生成 320px JPEG 传上来（几十 KB）。
  app.post('/api/thumbs/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
    if (auth !== 'ok') return authFail(c, auth);
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (item.kind !== 'image' && item.kind !== 'video') {
      return c.json({ ok: false, error: '仅支持图片或视频缩略图' }, 400);
    }
    const ct = c.req.header('Content-Type') || '';
    if (!ct.startsWith('image/')) return c.json({ ok: false, error: '缩略图必须是图片' }, 400);
    let buf;
    try {
      buf = new Uint8Array(await c.req.arrayBuffer());
    } catch (e) {
      return c.json({ ok: false, error: '没有收到缩略图' }, 400);
    }
    if (buf.byteLength > 512 * 1024) return c.json({ ok: false, error: '缩略图太大' }, 413);
    if (!buf.byteLength) return c.json({ ok: false, error: '没有收到缩略图' }, 400);
    const thumbMime = detectThumbMime(buf);
    await deps.local.putThumb(id, buf, thumbMime);
    // 顺手回填媒体分辨率（仅当原记录尚未写入宽高时）。
    const w = parseDim(c.req.header('X-Media-Width'));
    const h = parseDim(c.req.header('X-Media-Height'));
    if (w && h && (!item.width || !item.height)) {
      try { await deps.meta.updateFile(id, { width: w, height: h }); } catch {}
    }
    return c.json({ ok: true });
  });

  // 缩略图查看：权限跟原文件一致（公开文件谁都能看，私密文件只有管理员能看；过期的看不到）。
  app.get('/thumb/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const item = await deps.meta.getFile(id);
    if (!item || isExpired(item)) return c.json({ ok: false, error: 'not found' }, 404);
    const authed = await isAuthed(c, deps);
    if (item.deletedAt && !authed) return c.json({ ok: false, error: 'not found' }, 404);
    if (!authed && item.visibility !== 'public') {
      return c.json({ ok: false, error: 'not found' }, 404);
    }
    const buf = await deps.local.getThumb(id);
    if (!buf) return c.json({ ok: false, error: 'not found' }, 404);
    const contentType = detectThumbMime(buf);
    const etag = `"th-${id}-${buf.byteLength}"`;
    const isPrivate = item.visibility !== 'public';
    const cacheControl = item.deletedAt
      ? 'private, no-store'
      : isPrivate
        ? 'private, max-age=31536000, immutable'
        : (item.expiresAt ? 'public, max-age=3600' : 'public, max-age=31536000, immutable');
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag,
    };
    if (isPrivate || item.deletedAt) headers['Vary'] = 'Cookie';
    const inm = (c.req.header('If-None-Match') || '').trim();
    if (!item.deletedAt && inm && (inm === etag || inm === `W/${etag}`)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(buf, { status: 200, headers });
  });
}
