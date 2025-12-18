-- Waitlist tables (persisted queue)

CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_type text NOT NULL CHECK (group_type IN ('singles', 'doubles')),
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'paused', 'assigned', 'cancelled')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz NULL,
  assigned_session_id uuid NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_waitlist_status_position ON waitlist(status, position) WHERE status = 'waiting';
CREATE INDEX idx_waitlist_joined_at ON waitlist(joined_at);

CREATE TABLE waitlist_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_id uuid NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
  member_id uuid NULL REFERENCES members(id) ON DELETE RESTRICT,
  guest_name text NULL,
  participant_type text NOT NULL CHECK (participant_type IN ('member', 'guest')),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_waitlist_participant CHECK (
    (participant_type = 'member' AND member_id IS NOT NULL AND guest_name IS NULL) OR
    (participant_type = 'guest' AND member_id IS NULL AND guest_name IS NOT NULL)
  )
);

CREATE INDEX idx_waitlist_members_waitlist_id ON waitlist_members(waitlist_id);
CREATE INDEX idx_waitlist_members_member_id ON waitlist_members(member_id);
