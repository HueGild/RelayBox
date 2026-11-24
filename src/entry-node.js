// RelayBox — VPS entry (Node.js).
// Builds the Hono app from src/core with the Node adapters (JsonMetaStore +
// LocalStorage / R2Storage), serves it with @hono/node-server, and hosts the
// static frontend (public/) on the same origin. Baseline behaviour: v2.8.4.
//
// Layout (all relative to the app root):
//   RELAYBOX_ROOT (env) or cwd — config.json, data/, files/, thumbs/, public/
//   PORT (env, default 80), MAX_UPLOAD_SIZE (env, default 10GB for VPS).

import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './core/app.js';
import { JsonMetaStore } from './adapters/node/json-meta.js';
import { LocalStorage } from './adapters/node/local-storage.js';
import { R2Storage } from './adapters/node/r2-storage.js';
import { parseMultipartUpload } from './adapters/node/multipart.js';
import { cleanupExpired } from './core/lib/cleanup.js';
import { log } from './core/lib/util.js';

const ROOT = process.env.RELAYBOX_ROOT || process.cwd();
const PORT = Number(process.env.PORT || 80);
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE || 10 * 1024 * 1024 * 1024);

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch { /* no config.json: env vars only */ }
  const uploadPassword = process.env.UPLOAD_PASSWORD || file.uploadPassword || '';
  const r2 = {
    bucket: process.env.R2_BUCKET || (file.r2 && file.r2.bucket) || '',
    endpoint: process.env.R2_ENDPOINT || (file.r2 && file.r2.endpoint) || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || (file.r2 && file.r2.accessKeyId) || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || (file.r2 && file.r2.secretAccessKey) || '',
  };
  return { uploadPassword, r2 };
}

const config = loadConfig();
if (!config.uploadPassword) {
  log('WARNING: no upload password configured (config.json uploadPassword or UPLOAD_PASSWORD env); login/upload will fail');
}

const dataDir = path.join(ROOT, 'data');
const filesDir = path.join(ROOT, 'files');
const thumbsDir = path.join(ROOT, 'thumbs');
const publicDir = path.join(ROOT, 'public');

const meta = new JsonMetaStore(dataDir);
const local = new LocalStorage(filesDir, thumbsDir);
const r2 = new R2Storage(config.r2);

const deps = {
  meta,
  local,
  r2,
  config: {
    uploadPassword: config.uploadPassword,
    maxUploadSize: MAX_UPLOAD_SIZE,
    r2Enabled: r2.enabled,
  },
  parseMultipart: (c, opts) => parseMultipartUpload(c, opts),
  // Client IP for the rate limiter (socket address when no X-Forwarded-For).
  getClientIp: (c) => {
    try {
      return getConnInfo(c).remote.address || 'unknown';
    } catch {
      return 'unknown';
    }
  },
};

const app = createApp(deps);

// Static frontend (same origin, no CORS split). Mirrors v2.8.4's static branches.
function serveFile(c, file, contentType, cache) {
  try {
    const data = fs.readFileSync(path.join(publicDir, file));
    const headers = { 'Content-Type': contentType };
    if (cache) headers['Cache-Control'] = 'public, max-age=86400';
    return new Response(data, { status: 200, headers });
  } catch {
    return c.json({ ok: false, error: 'not found' }, 404);
  }
}
app.get('/', (c) => serveFile(c, 'index.html', 'text/html; charset=utf-8'));
app.get('/s/*', (c) => serveFile(c, 'index.html', 'text/html; charset=utf-8'));
app.get('/qrcode.min.js', (c) => serveFile(c, 'qrcode.min.js', 'application/javascript; charset=utf-8', true));
app.get('/jszip.min.js', (c) => serveFile(c, 'jszip.min.js', 'application/javascript; charset=utf-8', true));

// Expiry + stale-chunk cleanup: at startup and every 5 minutes (same as v2.8.4).
setInterval(() => {
  cleanupExpired(deps).catch((e) => log('cleanup error:', e && e.message));
}, 5 * 60 * 1000);
cleanupExpired(deps).catch((e) => log('cleanup error:', e && e.message));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  log(`relaybox listening on :${info.port} (root=${ROOT}, r2=${r2.enabled ? 'enabled' : 'disabled'}, maxUpload=${MAX_UPLOAD_SIZE})`);
});
