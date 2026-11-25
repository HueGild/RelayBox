-- RelayBox D1 migration 0004: file pinning/notes + 30-day security audit logs (v3.6.0).
ALTER TABLE files ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_files_pinned ON files(folder_id, deleted_at, pinned DESC, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  geo TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
