-- RelayBox v3.2 incremental migration: multi-storage pools (dynamic external R2 / S3 buckets).
-- Run BEFORE deploying v3.2 Worker code.
-- All changes are backward compatible; existing files keep pool_id = NULL (built-in R2).

CREATE TABLE IF NOT EXISTS storage_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 's3',
  endpoint TEXT NOT NULL,
  bucket TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto',
  access_key_id TEXT NOT NULL,
  secret_key_enc TEXT NOT NULL,
  public_domain TEXT NOT NULL DEFAULT '',
  transfer_mode TEXT NOT NULL DEFAULT 'presign',
  quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

ALTER TABLE files ADD COLUMN pool_id TEXT;
ALTER TABLE chunk_uploads ADD COLUMN pool_id TEXT;
