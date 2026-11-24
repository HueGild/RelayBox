-- RelayBox v3.1.5 incremental migration: file details (upload IP, geo, media resolution).
-- Run BEFORE deploying the updated Worker code, otherwise INSERT/UPDATE on files
-- with the new columns will fail:
--   npx wrangler d1 execute relaybox --remote --file=src/migrations/002_file_details.sql
-- All columns are nullable and fully backward compatible with existing rows.

ALTER TABLE files ADD COLUMN upload_ip TEXT;
ALTER TABLE files ADD COLUMN upload_geo TEXT;
ALTER TABLE files ADD COLUMN width INTEGER;
ALTER TABLE files ADD COLUMN height INTEGER;
