-- End sessions when scheduled blocks start
-- Called by get-board before returning data

CREATE OR REPLACE FUNCTION end_sessions_for_started_blocks()
RETURNS INTEGER
AS $$
DECLARE
  v_ended_count INTEGER := 0;
BEGIN
  -- End sessions that overlap with active blocks
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
    RETURNING s.id
  )
  SELECT COUNT(*) INTO v_ended_count FROM ended;
  
  RETURN v_ended_count;
END;
$$ LANGUAGE plpgsql;
