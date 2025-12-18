-- System settings and operating hours

CREATE TABLE system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT
);

CREATE TRIGGER update_system_settings_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE operating_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_of_week integer NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  is_closed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_day_of_week UNIQUE (day_of_week),
  CONSTRAINT valid_hours CHECK (is_closed = true OR closes_at > opens_at)
);

CREATE TRIGGER update_operating_hours_updated_at BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE operating_hours_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date UNIQUE NOT NULL,
  opens_at time NULL,
  closes_at time NULL,
  is_closed boolean NOT NULL DEFAULT false,
  reason text NULL,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_override CHECK (is_closed = true OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at))
);

CREATE INDEX idx_operating_hours_overrides_date ON operating_hours_overrides(date);
