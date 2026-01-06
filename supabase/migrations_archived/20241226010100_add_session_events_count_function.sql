-- Temporary function to verify session_events data integrity
-- Can be removed after verification

CREATE OR REPLACE FUNCTION count_session_events()
RETURNS TABLE (
  total_events BIGINT,
  end_events BIGINT,
  start_events BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_events,
    COUNT(*) FILTER (WHERE event_type = 'END')::BIGINT AS end_events,
    COUNT(*) FILTER (WHERE event_type = 'START')::BIGINT AS start_events
  FROM session_events;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION count_session_events() SET search_path = public, pg_temp;
GRANT EXECUTE ON FUNCTION count_session_events TO anon;
GRANT EXECUTE ON FUNCTION count_session_events TO service_role;

-- Also create a function to check integrity
CREATE OR REPLACE FUNCTION check_session_integrity()
RETURNS TABLE (
  issue_type TEXT,
  count BIGINT
) AS $$
BEGIN
  -- Sessions with END event but no actual_end_at
  RETURN QUERY
  SELECT 'END event exists, actual_end_at IS NULL'::TEXT, COUNT(*)::BIGINT
  FROM sessions s
  WHERE EXISTS (SELECT 1 FROM session_events se WHERE se.session_id = s.id AND se.event_type = 'END')
    AND s.actual_end_at IS NULL;

  -- Sessions with actual_end_at but no END event
  RETURN QUERY
  SELECT 'actual_end_at set, no END event'::TEXT, COUNT(*)::BIGINT
  FROM sessions s
  WHERE s.actual_end_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM session_events se WHERE se.session_id = s.id AND se.event_type = 'END');

  -- Sessions with actual_end_at IS NULL and no END event (active - expected)
  RETURN QUERY
  SELECT 'Active sessions (expected)'::TEXT, COUNT(*)::BIGINT
  FROM sessions s
  WHERE s.actual_end_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM session_events se WHERE se.session_id = s.id AND se.event_type = 'END');

  -- Sessions with both END event and actual_end_at (consistent - expected)
  RETURN QUERY
  SELECT 'Ended sessions (consistent)'::TEXT, COUNT(*)::BIGINT
  FROM sessions s
  WHERE s.actual_end_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM session_events se WHERE se.session_id = s.id AND se.event_type = 'END');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION check_session_integrity() SET search_path = public, pg_temp;
GRANT EXECUTE ON FUNCTION check_session_integrity TO anon;
GRANT EXECUTE ON FUNCTION check_session_integrity TO service_role;
