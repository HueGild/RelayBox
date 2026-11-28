-- RelayBox D1 schema (Cloudflare). See REFACTOR-PLAN.md §5 for the rules.
-- All timestamps are Unix milliseconds. No foreign keys: referential integrity
-- is enforced by the app layer, same as the JSON store on the VPS target.

-- Files (storage_key holds the physical key; old and new key formats coexist)
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'file',
  storage TEXT NOT NULL DEFAULT 'r2',
  storage_key TEXT NOT NULL,
  folder_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  expires_at INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  upload_ip TEXT,
  upload_geo TEXT,
  width INTEGER,
  height INTEGER,
  pool_id TEXT,
  deleted_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  owner_id TEXT DEFAULT NULL
);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_uploaded ON files(uploaded_at);
CREATE INDEX idx_files_deleted ON files(deleted_at);
CREATE INDEX idx_files_dir_list ON files(folder_id, deleted_at, uploaded_at DESC);
CREATE INDEX idx_files_pinned ON files(folder_id, deleted_at, pinned DESC, uploaded_at DESC);
CREATE INDEX idx_files_pool_del ON files(pool_id, deleted_at);
CREATE INDEX idx_files_expires ON files(expires_at);
CREATE INDEX idx_files_downloads ON files(deleted_at, downloads DESC);
CREATE INDEX idx_files_owner ON files(owner_id, deleted_at);

-- Folders (parent_id maintains the logical tree)
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

-- Shares (file_id XOR folder_id; v3.5.0 adds independent expires_at).
-- v3.1: max_downloads (0 = unlimited) / used_downloads / pickup_code (5-char).
CREATE TABLE shares (
  token TEXT PRIMARY KEY,
  file_id TEXT,
  folder_id TEXT,
  code TEXT NOT NULL DEFAULT '',
  burn INTEGER NOT NULL DEFAULT 0,
  max_downloads INTEGER NOT NULL DEFAULT 0,
  used_downloads INTEGER NOT NULL DEFAULT 0,
  pickup_code TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_shares_file ON shares(file_id);
CREATE INDEX idx_shares_folder ON shares(folder_id);
CREATE UNIQUE INDEX idx_shares_pickup_code ON shares(pickup_code);
CREATE INDEX idx_shares_expires ON shares(expires_at);

-- API Tokens (v3.1: geek one-click upload / later WebDAV reuse).
-- Only the SHA-256 hash is stored; the plaintext token is shown once at creation.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'upload',
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Drop links / file collection boxes (v3.2, created here with v3.1 for simplicity).
CREATE TABLE drop_links (
  token TEXT PRIMARY KEY,
  folder_id TEXT,
  title TEXT NOT NULL DEFAULT '文件收集',
  password_hash TEXT NOT NULL DEFAULT '',
  max_files INTEGER NOT NULL DEFAULT 0,
  used_files INTEGER NOT NULL DEFAULT 0,
  max_file_size INTEGER NOT NULL DEFAULT 104857600,
  visibility TEXT NOT NULL DEFAULT 'private',
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_drop_links_expires ON drop_links(expires_at);

-- Admin & sub-account sessions (user_id NULL = main admin; v3.8.0)
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  user_id TEXT DEFAULT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Announcement (single-row table)
CREATE TABLE announcement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL DEFAULT ''
);

-- Login brute-force protection (replaces the in-memory failMap)
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_attempts_ip_at ON login_attempts(ip, at);

-- Chunked-upload sessions (CF target; VPS target uses data/chunks/<uploadId>/meta.json)
-- received is a JSON array of [{ partNumber, etag }] — required to complete a
-- multipart upload. r2_upload_id is the R2 multipart upload id (CF only).
CREATE TABLE chunk_uploads (
  upload_id TEXT PRIMARY KEY,
  r2_upload_id TEXT,
  storage_key TEXT,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  total INTEGER NOT NULL,
  received TEXT NOT NULL DEFAULT '[]',
  storage TEXT NOT NULL DEFAULT 'r2',
  folder_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  expires_hours INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  pool_id TEXT
);
CREATE INDEX idx_chunks_created ON chunk_uploads(created_at);

-- Runtime settings (v3.1.6: e.g. r2_transfer_mode = 'presign' | 'proxy')
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Dynamic external storage pools (v3.2: extra R2 / S3-compatible buckets)
CREATE TABLE storage_pools (
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

-- Security & admin audit logs (v3.6.0, 30-day rolling retention)
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  geo TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- GitHub Release auto-pull watches (v3.7.0)
CREATE TABLE github_watches (
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
CREATE INDEX idx_gh_watches_enabled ON github_watches(enabled, last_checked_at);

-- Sub-accounts & temporary test accounts (v3.8.0)
CREATE TABLE users (
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
CREATE INDEX idx_users_role_enabled ON users(role, enabled);
