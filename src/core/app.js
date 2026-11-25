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
import { registerTokens } from './routes/tokens.js';
import { registerRawUpload } from './routes/raw-upload.js';
import { registerSettings } from './routes/settings.js';
import { registerPools } from './routes/pools.js';
import { registerDrops } from './routes/drops.js';
import { registerNotify } from './routes/notify.js';
import { registerRemoteFetch } from './routes/remote-fetch.js';
import { registerTextTools } from './routes/text-tools.js';
import { registerTrash } from './routes/trash.js';
import { registerMigrate } from './routes/migrate.js';
import { registerWebdav } from './routes/webdav.js';
import { registerStats } from './routes/stats.js';

export function createApp(depsOrFactory) {
  const isFactory = typeof depsOrFactory === 'function';
  if (!isFactory) {
    assertImplements(depsOrFactory.meta, MetaStoreMethods, 'MetaStore');
    assertImplements(depsOrFactory.local, StorageStoreMethods, 'LocalStorage');
    assertImplements(depsOrFactory.r2, StorageStoreMethods, 'R2Storage');
    if (!depsOrFactory.config || typeof depsOrFactory.config.uploadPassword !== 'string') {
      throw new Error('createApp: config.uploadPassword is required');
    }
  }

  const app = new Hono();
  app.use('*', async (c, next) => {
    const reqDeps = isFactory ? depsOrFactory(c) : depsOrFactory;
    c.set('deps', reqDeps);
    await next();
    if (c.res && c.res.headers) {
      const needNosniff = !c.res.headers.has('X-Content-Type-Options');
      const needReferrer = !c.res.headers.has('Referrer-Policy');
      if (needNosniff || needReferrer) {
        try {
          if (needNosniff) c.res.headers.set('X-Content-Type-Options', 'nosniff');
          if (needReferrer) c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        } catch {
          const headers = new Headers(c.res.headers);
          if (needNosniff) headers.set('X-Content-Type-Options', 'nosniff');
          if (needReferrer) headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
          c.res = new Response(c.res.body, {
            status: c.res.status,
            statusText: c.res.statusText,
            headers,
          });
        }
      }
    }
  });

  registerAuth(app);
  registerAnnounce(app);
  registerSettings(app);
  registerPools(app);
  registerDrops(app);
  registerNotify(app);
  registerRemoteFetch(app);
  registerTextTools(app);
  registerTrash(app);
  registerMigrate(app);
  registerWebdav(app);
  registerFiles(app);
  registerFolders(app);
  registerShares(app);
  registerUpload(app);
  registerChunks(app);
  registerThumbs(app);
  registerTokens(app);
  registerRawUpload(app);
  registerStats(app);

  // Unmatched routes: same 404 shape as v2.8.4.
  app.notFound((c) => c.json({ ok: false, error: 'not found' }, 404));
  app.onError((err, c) => {
    log('error:', err && err.message);
    return c.json({ ok: false, error: '服务器出错' }, 500);
  });

  return app;
}
