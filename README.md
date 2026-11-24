# RelayBox

Self-hosted file sharing with folders, share links, expiry, chunked upload and an
announcement bar. One codebase, two native deployments:

- **VPS** — Node.js, local disk + optional R2 (dual storage pools), Docker Compose one-command deploy.
- **Cloudflare** — Workers + R2 + D1 + Static Assets, `wrangler deploy` one-command deploy.

The frontend (`public/index.html`) is a single page that talks to the same API on both
targets — no changes needed between deployments.

## Features

- Upload to local disk and/or R2 (presigned direct upload, no bytes through the server)
- Chunked upload with resume (files over 32 MB, up to `MAX_UPLOAD_SIZE`)
- Folders with nesting, move and rename
- Public / private files, per-file and per-folder share links
- Extraction codes and burn-after-reading links
- File expiry (permanent / 24h / 7 days) with automatic cleanup
- Image thumbnails, grid / list views, search, sort and filter
- Download confirmation on share pages
- Announcement bar (admin-editable, dismissible)
- Admin login with brute-force protection

## Deploy

### Cloudflare (primary)

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

### VPS (Docker)

```sh
cp .env.example .env   # set UPLOAD_PASSWORD (and R2_* for the R2 pool)
docker compose up -d
```

Or run Node directly: `npm install && npm start` (port 80, data in `./data`, files in `./files`).

## Configuration

| Variable | Default (CF) | Default (VPS) | Notes |
|---|---|---|---|
| `UPLOAD_PASSWORD` | — | — | Admin password (required) |
| `MAX_UPLOAD_SIZE` | 5 GB | 10 GB | Single-file cap, bytes |

## Layout

```
src/
├── core/          # Hono routes + business logic (Web-standard APIs only, zero Node deps)
├── adapters/
│   ├── node/      # JsonMetaStore + LocalStorage + R2 (AWS SDK)
│   └── cf/        # D1MetaStore + R2 (Binding + aws4fetch for presigning)
├── entry-node.js  # VPS entry (@hono/node-server)
└── entry-worker.js# Cloudflare entry (fetch + scheduled cleanup)
```

See `REFACTOR-PLAN.md` for the full architecture, interface contracts and migration plan.
