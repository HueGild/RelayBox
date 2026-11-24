-- RelayBox Batch 1 (v3.1) incremental migration.
-- First migration in the repo (no 000 baseline file; src/schema.sql is the
-- full baseline for fresh deployments and already includes these changes).
-- Run before deploying the Batch 1 code, otherwise INSERT/UPDATE on shares
-- with the new columns will fail and share creation breaks entirely:
--   npx wrangler d1 execute relaybox --remote --file=src/migrations/001_v31_features.sql
-- All DDL is backward compatible: new columns have defaults, pickup_code is
-- nullable, and the new tables are created IF NOT EXISTS.

-- 1. 扩展 shares 表：支持下载次数上限与 5 位短取件码
-- 说明：兼容旧字段 burn（burn=1 等价于 max_downloads=1）
ALTER TABLE shares ADD COLUMN max_downloads INTEGER NOT NULL DEFAULT 0;   -- 0 = 不限，1 = 阅后即焚，N = 限次
ALTER TABLE shares ADD COLUMN used_downloads INTEGER NOT NULL DEFAULT 0;  -- 已通过该分享下载次数
ALTER TABLE shares ADD COLUMN pickup_code TEXT;                           -- 5 位短取件码（大写字母+数字，去 0/O/1/I/L）
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_pickup_code ON shares(pickup_code);

-- 2. API Token 表（极客一键上传 / 后续 WebDAV 复用）
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                    -- 备注名，如 "Mac ShareX" / "iPhone 快捷指令"
  token_hash TEXT NOT NULL UNIQUE,       -- SHA-256(明文 token) 十六进制，明文仅创建时展示一次
  prefix TEXT NOT NULL,                  -- 前 8 位预览，如 "rbx_a1b2"
  scope TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'all'
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 3. 反向分享 / 文件收集箱表（Batch 2：v3.2，可按需一并建表或拆到 002）
CREATE TABLE IF NOT EXISTS drop_links (
  token TEXT PRIMARY KEY,
  folder_id TEXT,                        -- 收集到的文件自动落入此目录（NULL = 根目录）
  title TEXT NOT NULL DEFAULT '文件收集',
  password_hash TEXT NOT NULL DEFAULT '',-- 可选提交口令，空 = 免密提交
  max_files INTEGER NOT NULL DEFAULT 0,  -- 最大收集份数，0 = 不限
  used_files INTEGER NOT NULL DEFAULT 0, -- 已收集份数
  max_file_size INTEGER NOT NULL DEFAULT 104857600, -- 单文件上限（默认 100MB）
  visibility TEXT NOT NULL DEFAULT 'private',       -- 收集文件默认私密，仅管理员可见
  expires_at INTEGER,                    -- 毫秒时间戳，NULL = 永久
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drop_links_expires ON drop_links(expires_at);
