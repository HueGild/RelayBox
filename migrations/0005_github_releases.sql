-- RelayBox D1 migration 0005: GitHub Release auto-pull watches (v3.7.0).
CREATE TABLE IF NOT EXISTS github_watches (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  asset_pattern TEXT NOT NULL DEFAULT '*',
  folder_id TEXT,
  pool_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  replace_old INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_tag TEXT NOT NULL DEFAULT '',
  last_file_ids TEXT NOT NULL DEFAULT '[]',
  last_checked_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gh_watches_enabled ON github_watches(enabled, last_checked_at);
