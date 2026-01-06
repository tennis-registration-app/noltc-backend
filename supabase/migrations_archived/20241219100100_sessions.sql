-- Sessions and participants (append-only court occupancy records)

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  session_type text NOT NULL CHECK (session_type IN ('singles', 'doubles')),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  scheduled_end_at timestamptz NOT NULL,
  actual_end_at timestamptz NULL,
  end_reason text NULL CHECK (end_reason IN ('completed', 'cleared_early', 'admin_override')),
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  ended_by_device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_end_time CHECK (actual_end_at IS NULL OR actual_end_at >= started_at),
  CONSTRAINT end_reason_required CHECK ((actual_end_at IS NULL AND end_reason IS NULL) OR (actual_end_at IS NOT NULL AND end_reason IS NOT NULL))
);

CREATE INDEX idx_sessions_court_active ON sessions(court_id, actual_end_at) WHERE actual_end_at IS NULL;
CREATE INDEX idx_sessions_started_at ON sessions(started_at);
CREATE INDEX idx_sessions_court_id ON sessions(court_id);

CREATE TABLE session_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  member_id uuid NULL REFERENCES members(id) ON DELETE RESTRICT,
  guest_name text NULL,
  participant_type text NOT NULL CHECK (participant_type IN ('member', 'guest')),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_participant CHECK (
    (participant_type = 'member' AND member_id IS NOT NULL AND guest_name IS NULL) OR
    (participant_type = 'guest' AND member_id IS NULL AND guest_name IS NOT NULL)
  )
);

CREATE INDEX idx_session_participants_session_id ON session_participants(session_id);
CREATE INDEX idx_session_participants_member_id ON session_participants(member_id);
CREATE INDEX idx_session_participants_account_id ON session_participants(account_id);
