# RelayBox

Self-hosted file sharing with folders, share links, expiry, chunked upload and an
announcement bar. Pure Cloudflare architecture:

- **Cloudflare** — Workers + R2 + D1 + Static Assets, `wrangler deploy` one-command deploy.

> Since v3.4.0 the project is Cloudflare-only. The last dual-end (CF + VPS) version
> is archived as Git Tag `v3.3.11-dual-final` / branch `archive/dual-v3.3.11` and
> `RelayBox-v3.3.11-dual-final-backup.zip` in Drive `RelayBox/archives/`. The VPS
> (Node.js) adapter was removed; development now only maintains the CF target and
> may use D1 native SQL and Cloudflare edge capabilities directly.

The frontend (`public/index.html`) is a single page that talks to the same API.

## Features

- Upload to R2 (presigned direct upload, no bytes through the server)
- Chunked upload with resume (files over 100 MB, up to `MAX_UPLOAD_SIZE`)
- Folders with nesting, move and rename
- Public / private files, per-file and per-folder share links
- Extraction codes and burn-after-reading links
- File expiry (permanent / 24h / 7 days) with automatic cleanup
- Image thumbnails, grid / list views, search, sort and filter
- Download confirmation on share pages
- Announcement bar (admin-editable, dismissible)
- Admin login with brute-force protection
- External storage pools (S3-compatible) with optional public-domain direct-out
- 7-day recycle bin, batch operations, WebDAV mount, Telegram notifications

## Deploy

### Cloudflare

```sh
npx wrangler d1 create relaybox          # create the D1 database, paste its id into wrangler.toml
npx wrangler d1 execute relaybox --file=src/schema.sql
npx wrangler r2 bucket create relaybox
npx wrangler secret put UPLOAD_PASSWORD
npx wrangler secret put R2_ACCESS_KEY_ID        # only used to sign presigned URLs (aws4fetch)
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler deploy
```

Or connect the Worker to this repo via Git integration (production branch `main`,
deploy command `npx wrangler deploy`) — every push to `main` then auto-deploys.

Set the bucket CORS to allow `PUT, GET, HEAD` from your domain and expose the `ETag`
header (browsers need it to complete multipart uploads).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `UPLOAD_PASSWORD` | — | Admin password (required) |
| `MAX_UPLOAD_SIZE` | 5 GB | Single-file cap, bytes |

## Layout

```
src/
├── core/          # Hono routes + business logic (Web-standard APIs only, zero Node deps)
├── adapters/
│   └── cf/        # D1MetaStore + R2 (Binding + aws4fetch for presigning)
├── entry-worker.js# Cloudflare entry (fetch + scheduled cleanup)
├── schema.sql     # D1 full baseline (fresh deploys; includes migrations 001-005)
└── migrations/    # Incremental D1 migrations for existing databases
```

## Tests

```sh
npm test            # v340-verify.mjs (full-app, D1 via node:sqlite) + test-batch1-d1.js (D1 SQL)
```

See `REFACTOR-PLAN.md` for the original dual-end architecture and migration plan
(historical — the VPS side was removed in v3.4.0). The current collaboration
spec lives in Drive `RelayBox/AGENTS.md`.
