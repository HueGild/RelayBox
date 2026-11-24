// RelayBox core — Hono app factory.
// Builds the Hono app from the route modules with the injected adapters
// (MetaStore / StorageStore / config / multipart parser). Pure Web APIs;
// the app never touches the filesystem or process env — entries provide deps.

import { Hono } from 'hono';
import { assertImplements, MetaStoreMethods, StorageStoreMethods } from './contracts.js';
import { log } from './lib/util.js';
import { registerAuth } from './routes/auth.js';
import { registerAnnounce } from './routes/announce.js';
import { registerFiles } from './routes/files.js';
import { registerFolders } from './routes/folders.js';
import { registerShares } from './routes/shares.js';
import { registerUpload } from './routes/upload.js';
import { registerChunks } from './routes/chunks.js';
import { registerThumbs } from './routes/thumbs.js';

/**
 * deps: {
 *   meta,            // MetaStore (JsonMetaStore / D1MetaStore)
 *   local,           // LocalStorage (VPS disk; CF: unused)
 *   r2,              // R2Storage (may be disabled when unconfigured)
 *   config: { uploadPassword, maxUploadSize, r2Enabled },
 *   parseMultipart,  // (c, { maxFileSize, filesDir }) => { fields, file, failed, tmpPath }
 *                     // Node-only (busboy); absent on CF (local upload is VPS-only).
 *   getClientIp,     // (c) => string — socket address for the rate limiter
 *                     // (Node entry: @hono/node-server conninfo; CF: cf-connecting-ip).
 * }
 */
export function createApp(deps) {
  assertImplements(deps.meta, MetaStoreMethods, 'MetaStore');
  assertImplements(deps.local, StorageStoreMethods, 'LocalStorage');
  assertImplements(deps.r2, StorageStoreMethods, 'R2Storage');
  if (!deps.config || typeof deps.config.uploadPassword !== 'string') {
    throw new Error('createApp: config.uploadPassword is required');
  }

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });

  registerAuth(app);
  registerAnnounce(app);
  registerFiles(app);
  registerFolders(app);
  registerShares(app);
  registerUpload(app);
  registerChunks(app);
  registerThumbs(app);

  // Unmatched routes: same 404 shape as v2.8.4.
  app.notFound((c) => c.json({ ok: false, error: 'not found' }, 404));
  app.onError((err, c) => {
    log('error:', err && err.message);
    return c.json({ ok: false, error: '服务器出错' }, 500);
  });

  return app;
}
