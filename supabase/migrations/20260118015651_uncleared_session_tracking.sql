-- Track uncleared session streaks for registrants
-- Used to remind players to clear their courts

-- Add streak counter to members
ALTER TABLE members
ADD COLUMN uncleared_streak INT NOT NULL DEFAULT 0;

-- Add registrant tracking to sessions
ALTER TABLE sessions
ADD COLUMN registered_by_member_id UUID REFERENCES members(id);

-- Index for quick lookup when updating streaks
CREATE INDEX idx_sessions_registered_by ON sessions(registered_by_member_id)
WHERE registered_by_member_id IS NOT NULL;

-- Comment
COMMENT ON COLUMN members.uncleared_streak IS
  'Count of consecutive sessions ended without player using Clear Court. Resets to 0 on proper clearance.';

COMMENT ON COLUMN sessions.registered_by_member_id IS
  'The member who initiated the registration. Used for uncleared session tracking.';
