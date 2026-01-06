-- Fix active_sessions_view column names to match what get_court_board expects
-- The function expects 'id' not 'session_id'

DROP VIEW IF EXISTS active_sessions_view;

CREATE VIEW active_sessions_view AS
SELECT 
  s.id,  -- Not 'session_id' - get_court_board expects 'id'
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id
FROM sessions s
WHERE 
  -- Session is active if no END event exists
  NOT EXISTS (
    SELECT 1 FROM session_events se 
    WHERE se.session_id = s.id 
    AND se.event_type = 'END'
  )
  -- Also check actual_end_at for legacy data
  AND s.actual_end_at IS NULL;

COMMENT ON VIEW active_sessions_view IS 
  'Active sessions - no END event and no actual_end_at. 
   Uses same column names as original for get_court_board compatibility.';
