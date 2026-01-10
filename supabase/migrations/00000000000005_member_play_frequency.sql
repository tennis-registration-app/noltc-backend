-- Add play frequency tracking to members
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS last_played_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS plays_180d int NOT NULL DEFAULT 0;

-- Index for sorting
CREATE INDEX IF NOT EXISTS idx_members_play_frequency ON members (plays_180d DESC, last_played_at DESC NULLS LAST);

-- Function to refresh plays_180d for all active members (nightly job)
CREATE OR REPLACE FUNCTION refresh_member_play_counts()
RETURNS TABLE (members_updated bigint, duration_ms int) AS $$
DECLARE
  start_ts timestamptz := clock_timestamp();
  updated bigint;
BEGIN
  -- Update play counts for all members who played in last 180 days
  WITH play_counts AS (
    SELECT
      sp.member_id,
      COUNT(DISTINCT sp.session_id) AS play_count,
      MAX(s.started_at) AS last_play
    FROM session_participants sp
    JOIN sessions s ON s.id = sp.session_id
    WHERE sp.member_id IS NOT NULL
      AND s.started_at >= NOW() - INTERVAL '180 days'
    GROUP BY sp.member_id
  )
  UPDATE members m
  SET
    plays_180d = COALESCE(pc.play_count, 0),
    last_played_at = pc.last_play
  FROM play_counts pc
  WHERE m.id = pc.member_id;

  GET DIAGNOSTICS updated = ROW_COUNT;

  -- Reset to 0 for members not in the count (haven't played in 180 days)
  UPDATE members
  SET plays_180d = 0
  WHERE plays_180d > 0
    AND id NOT IN (
      SELECT DISTINCT sp.member_id
      FROM session_participants sp
      JOIN sessions s ON s.id = sp.session_id
      WHERE sp.member_id IS NOT NULL
        AND s.started_at >= NOW() - INTERVAL '180 days'
    );

  members_updated := updated;
  duration_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - start_ts)::int;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to update last_played_at when session ends
CREATE OR REPLACE FUNCTION update_member_last_played()
RETURNS TRIGGER AS $$
BEGIN
  -- When a session's actual_end_at is set (session ended)
  IF OLD.actual_end_at IS NULL AND NEW.actual_end_at IS NOT NULL THEN
    UPDATE members m
    SET last_played_at = NEW.actual_end_at
    FROM session_participants sp
    WHERE sp.session_id = NEW.id
      AND sp.member_id IS NOT NULL
      AND m.id = sp.member_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trg_update_member_last_played ON sessions;
CREATE TRIGGER trg_update_member_last_played
  AFTER UPDATE OF actual_end_at ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_member_last_played();

GRANT EXECUTE ON FUNCTION refresh_member_play_counts() TO service_role;
