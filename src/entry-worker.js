// RelayBox Cloudflare Workers entry — CF deployment target.
// Built on the shared Hono core (src/core/app.js) with the CF adapters
// (D1MetaStore + R2Storage). The same codebase, same API contract as the
// VPS (Node) target; only the adapters and the entry differ.
//
// Bindings (wrangler.toml):
// - D1 Database `DB`, R2 Bucket `R2`, Static Assets (ASSETS).
// Secrets (set with `wrangler secret put`, never in the repo):
// - UPLOAD_PASSWORD          admin/upload password
// - R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
//   R2 S3 API credentials — needed ONLY for aws4fetch presigning
//   (env.R2 Binding cannot generate presigned URLs).
// Vars (wrangler.toml [vars]):
// - R2_BUCKET                bucket name (the Binding does not expose it;
//   presigned URLs need it)
// - MAX_UPLOAD_SIZE          default 5GB on CF
// - CLEANUP_INTERVAL_MS      unused here (scheduled trigger replaces it)
//
// Exported handlers:
// - fetch: HTTP requests (API + static assets + /s/* fallback).
// - scheduled: Cron Trigger (every 5 min) — the same expiry + stale-chunk
//   cleanup the VPS runs on a setInterval.

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
  // CF has no local disk: the same R2 instance serves as `local`
  // (its "local" extras report the R2 free allowance / no-op temp files).
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
      // CF 保持原策略不变：32MB 以上分片，每片 5MB（Workers 单请求上限 100MB，
      // 直传阈值不能超过它；R2 分片上传的每片也至少 5MB）。
      chunkUploadThreshold: 32 * 1024 * 1024,
      chunkSize: 5 * 1024 * 1024,
    },
    // Client IP for the rate limiter (Cloudflare sets cf-connecting-ip;
    // clientIp() already prefers X-Forwarded-For when present).
    getClientIp: (c) => c.req.header('cf-connecting-ip') || 'unknown',
  };
}

export default {
  /**
   * HTTP entry. Order matters:
   * 1. `/api/*` and `/f/:id` and `/thumb/:id` — the Hono app (shared core).
   * 2. `/` and `/s/*` — static `index.html` (pitfall #3: a share link
   *    must return the SPA, never a 404).
   * 3. Other static assets (qrcode.min.js, jszip.min.js) — ASSETS binding.
   * 4. Anything else — the SPA fallback (single-page-application).
   */
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
    // (Pitfall #3: /s/:token must NOT 404; the frontend renders the share.)
    // Fetch `/` (not `/index.html`): the Assets handler canonicalises
    // `/index.html` to `/` with a 307, while `/` serves the file directly.
    if (path === '/' || path.startsWith('/s/')) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }

    // 3) Static assets (qrcode.min.js, jszip.min.js, ...).
    const asset = await env.ASSETS.fetch(request);
    // 4) Unknown non-API path — fall back to the SPA (mirrors the
    // `not_found_handling = "single-page-application"` in wrangler.toml).
    if (asset.status === 404) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }
    return asset;
  },

  /**
   * Cron Trigger (wrangler.toml [triggers] crons, every 5 minutes).
   * Same two cleanups the VPS runs on a setInterval: expired files and
   * stale chunk uploads (> 24h).
   */
  async scheduled(event, env, ctx) {
    const deps = buildDeps(env);
    // cleanupExpired also prunes expired sessions and calls cleanupChunks.
    await cleanupExpired(deps);
  },
};
