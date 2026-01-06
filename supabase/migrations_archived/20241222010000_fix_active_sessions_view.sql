-- Fix active_sessions_view to use session_events as source of truth
-- Instead of relying on actual_end_at, check for absence of END event

DROP VIEW IF EXISTS active_sessions_view;

CREATE VIEW active_sessions_view AS
SELECT 
  s.id AS session_id,
  s.court_id,
  c.court_number,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.created_by_device_id,
  -- Calculate minutes remaining
  GREATEST(0, EXTRACT(EPOCH FROM (s.scheduled_end_at - NOW())) / 60)::integer AS minutes_remaining,
  -- Get participants from session_participants
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'member_id', sp.member_id,
      'display_name', COALESCE(m.display_name, sp.guest_name),
      'participant_type', sp.participant_type
    ))
    FROM session_participants sp
    LEFT JOIN members m ON sp.member_id = m.id
    WHERE sp.session_id = s.id),
    '[]'::jsonb
  ) AS participants
FROM sessions s
JOIN courts c ON s.court_id = c.id
WHERE 
  -- Session is active if no END event exists
  NOT EXISTS (
    SELECT 1 FROM session_events se 
    WHERE se.session_id = s.id 
    AND se.event_type = 'END'
  )
  -- Also check actual_end_at for legacy data (can be removed in Phase 2)
  AND s.actual_end_at IS NULL;

-- Add comment explaining the view
COMMENT ON VIEW active_sessions_view IS 
  'Active sessions derived from session_events (no END event). 
   The actual_end_at check is for legacy compatibility and can be removed in Phase 2.';
