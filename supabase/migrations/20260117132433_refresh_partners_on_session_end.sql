-- Trigger function to refresh frequent partners cache when session ends
CREATE OR REPLACE FUNCTION refresh_partners_on_session_end()
RETURNS TRIGGER AS $$
DECLARE
  participant_member_id UUID;
BEGIN
  -- Only run when actual_end_at transitions from NULL to NOT NULL
  IF OLD.actual_end_at IS NULL AND NEW.actual_end_at IS NOT NULL THEN
    -- Refresh cache for each member participant in this session
    FOR participant_member_id IN
      SELECT DISTINCT sp.member_id
      FROM session_participants sp
      WHERE sp.session_id = NEW.id
        AND sp.member_id IS NOT NULL
    LOOP
      PERFORM refresh_single_member_cache(participant_member_id);
    END LOOP;

    RAISE NOTICE 'Refreshed frequent partners cache for session %', NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger on sessions table
DROP TRIGGER IF EXISTS trg_refresh_partners_on_session_end ON sessions;

CREATE TRIGGER trg_refresh_partners_on_session_end
  AFTER UPDATE ON sessions
  FOR EACH ROW
  WHEN (OLD.actual_end_at IS NULL AND NEW.actual_end_at IS NOT NULL)
  EXECUTE FUNCTION refresh_partners_on_session_end();

-- Add comment for documentation
COMMENT ON TRIGGER trg_refresh_partners_on_session_end ON sessions IS
  'Automatically refreshes frequent partners cache for all participants when a session ends';
