-- RelayBox D1 schema (Cloudflare). See REFACTOR-PLAN.md §5 for the rules.
-- All timestamps are Unix milliseconds. No foreign keys: referential integrity
-- is enforced by the app layer, same as the JSON store on the VPS target.

-- Files (storage_key holds the physical key; old and new key formats coexist)
CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  ext         TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'file',
  storage     TEXT NOT NULL DEFAULT 'r2',
  storage_key TEXT NOT NULL,
  folder_id   TEXT,
  visibility  TEXT NOT NULL DEFAULT 'public',
  expires_at  INTEGER,
  downloads   INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_uploaded ON files(uploaded_at);

-- Folders (parent_id maintains the logical tree)
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

-- Shares (file_id XOR folder_id; no independent expiry — a share follows its file)
CREATE TABLE shares (
  token      TEXT PRIMARY KEY,
  file_id    TEXT,
  folder_id  TEXT,
  code       TEXT NOT NULL DEFAULT '',
  burn       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_shares_file ON shares(file_id);
CREATE INDEX idx_shares_folder ON shares(folder_id);

-- Admin sessions (replaces sessions.json)
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Announcement (single-row table)
CREATE TABLE announcement (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
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
  upload_id     TEXT PRIMARY KEY,
  r2_upload_id  TEXT,
  storage_key   TEXT,
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  received      TEXT NOT NULL DEFAULT '[]',
  storage       TEXT NOT NULL DEFAULT 'r2',
  folder_id     TEXT,
  visibility    TEXT NOT NULL DEFAULT 'public',
  expires_hours INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_chunks_created ON chunk_uploads(created_at);
