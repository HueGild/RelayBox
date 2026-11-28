-- RelayBox v3.9.1: store AES-GCM encrypted API token so admin can reveal/copy on demand.
ALTER TABLE api_tokens ADD COLUMN token_enc TEXT NOT NULL DEFAULT '';
