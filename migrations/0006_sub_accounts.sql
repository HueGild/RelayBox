-- RelayBox v3.8.0: Sub-accounts & Temporary Test Accounts
-- Adds users table, sessions.user_id, and files.owner_id for sandboxed multi-user quotas.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  root_folder_id TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  can_upload INTEGER NOT NULL DEFAULT 1,
  can_delete INTEGER NOT NULL DEFAULT 1,
  can_share INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_role_enabled ON users(role, enabled);

ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

ALTER TABLE files ADD COLUMN owner_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id, deleted_at);
