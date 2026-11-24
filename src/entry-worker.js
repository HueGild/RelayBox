// RelayBox Cloudflare Workers entry — CF deployment target.
// Built on the shared Hono core (src/core/app.js) with the CF adapters
// (D1MetaStore + R2Storage). The same codebase, same API contract as the
// VPS (Node) target; only the adapters and the entry differ.

import { createApp } from './core/app.js';
import { D1MetaStore } from './adapters/cf/d1-meta.js';
import { R2Storage } from './adapters/cf/r2-storage.js';
import { cleanupExpired } from './core/lib/cleanup.js';

// MAX_UPLOAD_SIZE on CF defaults to 5GB (VPS default is 10GB).
const CF_MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;

/** Build the deps object (meta + local + r2 + config) from the Worker env. */
function buildDeps(env) {
  const r2 = new R2Storage({
    binding: env.R2,
    bucket: env.R2_BUCKET || '',
    accountId: env.R2_ACCOUNT_ID || '',
    accessKeyId: env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
  });
  const meta = new D1MetaStore(env.DB, r2);
  const maxUploadSize = env.MAX_UPLOAD_SIZE
    ? Number(env.MAX_UPLOAD_SIZE)
    : CF_MAX_UPLOAD_SIZE;
  return {
    meta,
    local: r2,
    r2,
    config: {
      uploadPassword: env.UPLOAD_PASSWORD || '',
      maxUploadSize,
      // CF 上传策略：100MB 以下预签名直传，超过 100MB 分片每片 20MB（留足 128MB 内存余量）。
      chunkUploadThreshold: 100 * 1024 * 1024,
      chunkSize: 20 * 1024 * 1024,
    },
    getClientIp: (c) => c.req.header('cf-connecting-ip') || 'unknown',
    // Cloudflare Workers 原生免费地理信息（零外部调用、零额外延迟）。
    getClientGeo: (c) => {
      const cf = c.req.raw && c.req.raw.cf;
      if (cf && typeof cf === 'object') {
        const parts = [];
        for (const v of [cf.country, cf.region, cf.city]) {
          const s = (typeof v === 'string') ? v.trim() : '';
          if (s && s !== 'XX' && s !== 'T1' && !parts.includes(s)) parts.push(s);
        }
        if (parts.length) return parts.join(' · ').slice(0, 120);
      }
      const country = (c.req.header('cf-ipcountry') || '').trim();
      return (country && country !== 'XX' && country !== 'T1') ? country : '';
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1) API + file download + thumbnail routes — the shared Hono core.
    if (
      path.startsWith('/api/') ||
      path.startsWith('/f/') ||
      path.startsWith('/thumb/') ||
      path.startsWith('/__')
    ) {
      const app = createApp(buildDeps(env));
      return app.fetch(request, env, ctx);
    }

    // 2) SPA entry points: `/` and share pages `/s/:token` — index.html.
    if (path === '/' || path.startsWith('/s/')) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }

    // 3) Static assets (qrcode.min.js, jszip.min.js, ...).
    const asset = await env.ASSETS.fetch(request);
    // 4) Unknown non-API path — fall back to the SPA.
    if (asset.status === 404) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }
    return asset;
  },

  async scheduled(event, env, ctx) {
    const deps = buildDeps(env);
    await cleanupExpired(deps);
  },
};
