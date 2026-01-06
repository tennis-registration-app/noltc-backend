-- Phase 3A: Location tokens for QR-based geofence bypass
-- Used when mobile GPS is unavailable/unreliable

CREATE TABLE location_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(32) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by_device_id UUID REFERENCES devices(id),
  used_at TIMESTAMPTZ,
  used_by_member_id UUID REFERENCES members(id),
  used_by_device_id UUID REFERENCES devices(id)
);

-- Index for token lookup
CREATE INDEX idx_location_tokens_token ON location_tokens(token);

-- Index for cleanup of expired tokens
CREATE INDEX idx_location_tokens_expires_at ON location_tokens(expires_at);

-- RLS: Only service role can access
ALTER TABLE location_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE location_tokens IS 'Short-lived tokens for QR-based location verification when GPS is unavailable';
COMMENT ON COLUMN location_tokens.token IS '32-char random token displayed as QR code';
COMMENT ON COLUMN location_tokens.expires_at IS 'Token valid until this time (typically 5-10 minutes)';
COMMENT ON COLUMN location_tokens.used_at IS 'When token was redeemed (NULL if unused)';
