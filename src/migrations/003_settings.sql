-- RelayBox v3.1.6 incremental migration: runtime settings table (for R2 transfer mode toggle).
-- Run BEFORE deploying v3.1.6 Worker code:
--   npx wrangler d1 execute relaybox --remote --file=src/migrations/003_settings.sql
-- Fully backward compatible; D1MetaStore.getSetting also degrades gracefully if absent.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
