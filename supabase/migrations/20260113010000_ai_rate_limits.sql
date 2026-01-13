-- Rate limiting table for AI Assistant
CREATE TABLE ai_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ai_rate_limits_device_time ON ai_rate_limits(device_id, created_at DESC);
