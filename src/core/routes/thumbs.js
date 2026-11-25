// RelayBox core routes — thumbnails (upload / view).
// Supports both image and video thumbnails (v3.1.5) and optionally backfills
// media width/height from X-Media-Width / X-Media-Height headers.

import { isExpired, parseDim } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail } from '../lib/auth.js';

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
    await deps.local.putThumb(id, buf);
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
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': item.deletedAt ? 'private, no-store' : 'public, max-age=86400',
      },
    });
  });
}
