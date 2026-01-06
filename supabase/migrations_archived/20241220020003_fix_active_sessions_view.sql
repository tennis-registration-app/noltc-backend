-- Fix active_sessions_view to use transitional approach
-- Supports both legacy (actual_end_at) and new (session_events) end markers
-- Going forward, end-session will only INSERT END events, not UPDATE actual_end_at

DROP VIEW IF EXISTS active_sessions_view;
CREATE OR REPLACE VIEW active_sessions_view AS
SELECT
  s.id,
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id
FROM sessions s
WHERE s.actual_end_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM session_events se
    WHERE se.session_id = s.id AND se.event_type = 'END'
  );

COMMENT ON VIEW active_sessions_view IS
  'Transitional view: session is active if actual_end_at IS NULL AND no END event exists. End-session writes only to session_events going forward.';
