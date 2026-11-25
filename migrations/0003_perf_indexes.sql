-- RelayBox D1 migration 0003: composite & query performance indexes (v3.5.1).
CREATE INDEX IF NOT EXISTS idx_files_dir_list ON files(folder_id, deleted_at, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_pool_del ON files(pool_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_files_downloads ON files(deleted_at, downloads DESC);
