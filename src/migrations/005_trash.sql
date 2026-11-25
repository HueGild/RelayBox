-- RelayBox D1 migration 005: 7-day recycle bin (soft delete via files.deleted_at).
ALTER TABLE files ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
