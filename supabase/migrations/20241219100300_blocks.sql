-- Court blocks (lessons, clinics, maintenance, wet courts)

CREATE TABLE blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  block_type text NOT NULL CHECK (block_type IN ('lesson', 'clinic', 'maintenance', 'wet', 'other')),
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  is_recurring boolean NOT NULL DEFAULT false,
  recurrence_rule text NULL,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  CONSTRAINT valid_block_times CHECK (ends_at > starts_at),
  CONSTRAINT recurrence_rule_required CHECK ((is_recurring = false AND recurrence_rule IS NULL) OR (is_recurring = true AND recurrence_rule IS NOT NULL))
);

CREATE INDEX idx_blocks_court_time ON blocks(court_id, starts_at, ends_at) WHERE cancelled_at IS NULL;
CREATE INDEX idx_blocks_starts_at ON blocks(starts_at);
