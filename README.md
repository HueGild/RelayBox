# RelayBox

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

Self-hosted file sharing with folders, share links, expiry, chunked upload, drop links, WebDAV, and an announcement bar. Pure Cloudflare architecture:

- **Cloudflare** — Workers + R2 + D1 + Static Assets, one-click deploy or `wrangler deploy`.

> Since v3.4.0 the project is Cloudflare-only. The last dual-end (CF + VPS) version
> is archived as Git Tag `v3.3.11-dual-final` / branch `archive/dual-v3.3.11` and
> `RelayBox-v3.3.11-dual-final-backup.zip` in Drive `RelayBox/archives/`.

The frontend (`public/index.html`) is a single page that talks to the same API.

## Features

- Built-in R2 proxy & presigned direct upload modes (proxy works out of the box with zero S3 API keys)
- Chunked upload with resume (files over 100 MB, up to `MAX_UPLOAD_SIZE`)
- Folders with nesting, move, rename, URL routing (`/?folder=<id>`), and one-click ZIP download
- Public / private files, per-file and per-folder share links, 5-char pickup codes, extraction codes, burn-after-reading, and Share Management Center
- Visitor drop links (`/d/:token`) for write-only file collection
- File expiry (permanent / 24h / 7 days) with automatic Cron cleanup & 7-day recycle bin
- Image/video thumbnails, Markdown preview & code line numbers, inline text editor & Pastebin
- Custom desktop/mobile wallpapers, themes, announcement bar, and admin brute-force protection
- External S3/R2 storage pools with optional `publicDomain` direct-out, WebDAV mount, and Telegram notifications

## Deploy

### One-Click Deploy (Recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

1. Make sure **R2** is enabled in your Cloudflare Dashboard (10 GB/month free tier; requires a payment method on file, $0 within free tier).
2. Click **Deploy to Cloudflare** above — Cloudflare will clone this repository to your GitHub account, automatically provision a new **D1 database** and **R2 bucket**, run `migrations/0001_init.sql` to initialize all tables, and deploy your Worker.
3. In **Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets**, add a Secret named `UPLOAD_PASSWORD` (your admin login password).
4. Done! Built-in R2 **proxy mode** works immediately with zero extra keys. *(Optional: add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID` + bucket CORS exposing `ETag` if you want presigned direct uploads for multi-GB files.)*

### Manual CLI Deploy

```sh
npx wrangler d1 create relaybox # create the D1 database, paste its id into wrangler.toml
npx wrangler r2 bucket create relaybox
npx wrangler secret put UPLOAD_PASSWORD
# Optional: only needed if you want presigned direct uploads (otherwise proxy mode works out of the box)
# npx wrangler secret put R2_ACCESS_KEY_ID
# npx wrangler secret put R2_SECRET_ACCESS_KEY
# npx wrangler secret put R2_ACCOUNT_ID
npm run deploy # applies D1 migrations automatically, then runs wrangler deploy
```

Or connect the Worker to your repo via Git integration (production branch `main`, deploy command `npm run deploy`) — every push to `main` then auto-migrates and deploys.

## Configuration

| Variable / Secret | Required | Default | Notes |
|---|---|---|---|
| `UPLOAD_PASSWORD` | **Yes** | — | Admin login password (Secret) |
| `MAX_UPLOAD_SIZE` | No | 5 GB | Single-file cap in bytes |
| `R2_ACCESS_KEY_ID` | No | — | Optional; only for presigned direct upload |
| `R2_SECRET_ACCESS_KEY` | No | — | Optional; only for presigned direct upload |
| `R2_ACCOUNT_ID` | No | — | Optional; only for presigned direct upload |

## Layout

```text
migrations/
└── 0001_init.sql     # Idempotent D1 baseline migration (auto-applied on deploy)
public/
└── index.html        # Single-file SPA + PWA frontend
src/
├── core/             # Hono routes + business logic (Web-standard APIs only, zero Node deps)
├── adapters/
│   └── cf/           # D1MetaStore + R2 (Binding + aws4fetch for presigning)
├── entry-worker.js   # Cloudflare entry (fetch + scheduled cleanup)
├── schema.sql        # D1 full baseline reference
└── migrations/       # Legacy incremental SQL scripts (001-005)
```

## Tests

```sh
npm test # v340-verify.mjs (full-app, D1 via node:sqlite) + test-batch1-d1.js (D1 SQL)
```
