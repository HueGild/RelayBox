<div align="center">

# <img src="public/logo.png" width="32" height="32" align="center"> RelayBox

**A self-hosted file sharing & personal cloud drive running purely on Cloudflare (Workers + D1 + R2 + Static Assets).**

[![GitHub Stars](https://img.shields.io/github/stars/HueGild/relaybox?style=flat-square&logo=github)](https://github.com/HueGild/relaybox/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/HueGild/relaybox?style=flat-square&logo=github)](https://github.com/HueGild/relaybox/network/members)
[![License](https://img.shields.io/github/license/HueGild/relaybox?style=flat-square)](https://github.com/HueGild/relaybox/blob/main/LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

[简体中文](README.md) | **English**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

</div>

## Features

- **Built-in R2 Proxy & Presigned Modes**: Proxy mode works out of the box with zero S3 API keys; presigned mode supports chunked resumable uploads up to `MAX_UPLOAD_SIZE` (default 5 GB).
- **Dynamic External S3 / R2 Pools**: Mount extra R2/B2/MinIO buckets from the web UI (AES-GCM encrypted credentials), optional `publicDomain` 302 preview redirect, and cross-pool streaming migration.
- **Sub-Accounts & Temporary Test Accounts (v3.8.0)**: Create regular sub-accounts or expiring/quota-limited guest accounts (with 1-click presets for regular, 24h read-write test, and 7d read-only demo), PBKDF2-SHA256 Web Crypto password hashing, strict folder subtree sandboxing, per-user storage quotas, instant session kick/revocation, and 120s auto-hiding credential summaries.
- **Sharing, Pickup Codes & Drop Links**: File/folder shares with extraction codes, independent expiry, download limits, burn-after-reading, 5-char pickup codes, Share Management Center, browser-side ZIP download, and write-only visitor drop boxes (`/d/:token`).
- **GitHub Release Auto-Pull & Ops Dashboard (v3.6–v3.7)**: Pull GitHub Release assets manually or subscribe to scheduled watches (with tokenless HTML fallback and auto-replace to trash), plus D1-aggregated storage/download stats, 30-day security audit logs, file pinning/notes, pre-upload SHA-256 dedup, and a `Ctrl+K` command palette.
- **Modern SPA + PWA, WebDAV & Telegram Alerts**: URL folder routing (`/?folder=<id>`), Markdown preview & code line numbers, inline text editor & Pastebin, WebP image compression, video thumbnail capture, custom wallpapers, 7-day recycle bin, `/dav` WebDAV mount, `/api/raw-upload` API tokens, and Telegram notifications.

## One-Click Deploy (Recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

1. Enable **R2** in your Cloudflare Dashboard (10 GB/month free tier; payment method required on file, $0 within free tier).
2. Click **Deploy to Cloudflare** above — Cloudflare clones this repo to your GitHub, automatically provisions a **D1 database** and **R2 bucket**, applies D1 migrations (`0001`–`0006`), and deploys your Worker.
3. Add a Secret named `UPLOAD_PASSWORD` in **Workers & Pages → your Worker → Settings → Variables and Secrets**.
4. Open your Worker URL and sign in (leave username blank for main admin)! *(Optional: add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID` + bucket CORS exposing `ETag` to enable presigned direct uploads for multi-GB files.)*

## Manual CLI Deploy

```sh
git clone https://github.com/HueGild/relaybox.git
cd relaybox
npm install
npx wrangler d1 create relaybox    # paste database_id into wrangler.toml
npx wrangler r2 bucket create relaybox
npx wrangler secret put UPLOAD_PASSWORD
npm run deploy
```

## Configuration

| Variable / Secret | Type | Required | Default | Notes |
|---|---|---|---|---|
| `UPLOAD_PASSWORD` | Secret | **Yes** | — | Main admin password & pool secret encryption key |
| `MAX_UPLOAD_SIZE` | Var | No | `5368709120` (5 GB) | Single-file upload cap in bytes |
| `R2_BUCKET` | Var | No | `relaybox` | Built-in R2 bucket name (presign mode) |
| `R2_ACCESS_KEY_ID` | Secret | No | — | Optional; only for presigned direct upload |
| `R2_SECRET_ACCESS_KEY` | Secret | No | — | Optional; only for presigned direct upload |
| `R2_ACCOUNT_ID` | Secret | No | — | Optional; only for presigned direct upload |

## Tests

```sh
# Runs 101 D1 regression & sub-account security tests (Node built-in node:sqlite)
npm test
```

## License

[MIT](LICENSE)
