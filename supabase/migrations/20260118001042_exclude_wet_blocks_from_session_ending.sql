-- Fix: Exclude wet blocks from automatically ending sessions
-- Wet blocks are overlays that should not destroy active sessions
-- Only scheduled blocks (lessons, events, maintenance) should end sessions

CREATE OR REPLACE FUNCTION end_sessions_for_started_blocks()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_ended_count INTEGER := 0;
BEGIN
  -- End sessions that overlap with active blocks (except wet blocks)
  WITH ended AS (
    UPDATE sessions s
    SET actual_end_at = NOW(),
        end_reason = 'admin_override'
    FROM blocks b
    WHERE s.court_id = b.court_id
      AND s.actual_end_at IS NULL
      AND b.starts_at <= NOW()
      AND b.ends_at > NOW()
      AND b.cancelled_at IS NULL
      AND b.block_type != 'wet'  -- Exclude wet blocks (overlay only)
    RETURNING s.id
  )
  SELECT COUNT(*) INTO v_ended_count FROM ended;

  RETURN v_ended_count;
END;
$$;

COMMENT ON FUNCTION end_sessions_for_started_blocks IS
  'Ends active sessions on courts with active blocks, except wet blocks which are overlays only';
