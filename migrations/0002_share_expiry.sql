-- RelayBox D1 migration 0002: independent share link expiry (shares.expires_at).
ALTER TABLE shares ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
