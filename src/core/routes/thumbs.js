// RelayBox core routes — thumbnails (upload / view).
// Mirrors v2.8.4's handleThumbUpload / handleThumb exactly. Thumbnails are
// stored locally (thumbs/<id>.jpg) even for R2 files.

import { isExpired, log } from '../lib/util.js';
import { isAuthed, authOrPassword, authFail } from '../lib/auth.js';

export function registerThumbs(app) {
  // 缩略图上传：浏览器在图片上传成功后用 canvas 生成 320px JPEG 传上来（几十 KB）。
  app.post('/api/thumbs/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const auth = await authOrPassword(c, deps, c.req.header('X-Upload-Password') || '');
    if (auth !== 'ok') return authFail(c, auth);
    const item = await deps.meta.getFile(id);
    if (!item) return c.json({ ok: false, error: '文件不存在' }, 404);
    if (item.kind !== 'image') return c.json({ ok: false, error: '不是图片' }, 400);
    const ct = c.req.header('Content-Type') || '';
    if (!ct.startsWith('image/')) return c.json({ ok: false, error: '缩略图必须是图片' }, 400);
    let buf;
    try {
      buf = Buffer.from(await c.req.arrayBuffer());
    } catch (e) {
      return c.json({ ok: false, error: '没有收到缩略图' }, 400);
    }
    if (buf.length > 512 * 1024) return c.json({ ok: false, error: '缩略图太大' }, 413);
    if (!buf.length) return c.json({ ok: false, error: '没有收到缩略图' }, 400);
    await deps.local.putThumb(id, buf);
    return c.json({ ok: true });
  });

  // 缩略图查看：权限跟原文件一致（公开文件谁都能看，私密文件只有管理员能看；过期的看不到）。
  app.get('/thumb/:id', async (c) => {
    const deps = c.get('deps');
    const id = decodeURIComponent(c.req.param('id'));
    const item = await deps.meta.getFile(id);
    if (!item || isExpired(item)) return c.json({ ok: false, error: 'not found' }, 404);
    if (!(await isAuthed(c, deps)) && item.visibility !== 'public') {
      return c.json({ ok: false, error: 'not found' }, 404);
    }
    const buf = await deps.local.getThumb(id);
    if (!buf) return c.json({ ok: false, error: 'not found' }, 404);
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
    });
  });
}
