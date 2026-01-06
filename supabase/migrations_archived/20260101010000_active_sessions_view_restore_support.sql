-- Update active_sessions_view to recognize RESTORE events
--
-- Problem: When a session is restored after an overtime takeover:
--   1. actual_end_at is set to NULL ✓
--   2. But the END event still exists in session_events
--   3. The old view required NO END event to exist, so restored sessions didn't appear
--
-- Solution: A session is active if:
--   1. actual_end_at IS NULL, AND
--   2. Either no END event exists, OR a RESTORE event exists that's newer than the last END event
--
-- This maintains the event-sourced design where RESTORE compensates for END.

DROP VIEW IF EXISTS active_sessions_view;

CREATE VIEW active_sessions_view AS
SELECT
  s.id,
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id
FROM sessions s
WHERE
  s.actual_end_at IS NULL
  AND (
    -- Case 1: No END event exists (normal active session)
    NOT EXISTS (
      SELECT 1 FROM session_events se
      WHERE se.session_id = s.id
      AND se.event_type = 'END'
    )
    OR
    -- Case 2: A RESTORE event exists that is newer than the last END event
    -- (session was ended then restored - restored session is active)
    EXISTS (
      SELECT 1 FROM session_events restore_evt
      WHERE restore_evt.session_id = s.id
      AND restore_evt.event_type = 'RESTORE'
      AND restore_evt.created_at > (
        SELECT MAX(end_evt.created_at)
        FROM session_events end_evt
        WHERE end_evt.session_id = s.id
        AND end_evt.event_type = 'END'
      )
    )
  );

COMMENT ON VIEW active_sessions_view IS
  'Active sessions - no END event, or has RESTORE after END.
   Supports event-sourced lifecycle where RESTORE compensates for END.
   Uses same column names as original for get_court_board compatibility.';
