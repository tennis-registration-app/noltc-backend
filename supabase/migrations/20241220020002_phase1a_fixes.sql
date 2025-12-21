-- ============================================================================
-- PHASE 1A FIXES: Correct schema mismatches
-- ============================================================================

BEGIN;

-- ============================================================================
-- FIX 1: active_sessions_view should use actual_end_at (current approach)
-- not session_events (future approach)
-- ============================================================================

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
WHERE s.actual_end_at IS NULL;

COMMENT ON VIEW active_sessions_view IS
  'Active sessions (no actual_end_at). Internal view for Edge Functions only.';


-- ============================================================================
-- FIX 2: get_active_waitlist must join waitlist_members for participants
-- ============================================================================

CREATE OR REPLACE FUNCTION get_active_waitlist(request_time TIMESTAMPTZ DEFAULT NOW())
RETURNS TABLE (
  id UUID,
  "position" INT,
  group_type TEXT,
  joined_at TIMESTAMPTZ,
  minutes_waiting INT,
  participants JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.position,
    w.group_type,
    w.joined_at,
    CEIL(EXTRACT(EPOCH FROM (request_time - w.joined_at)) / 60)::INT AS minutes_waiting,
    COALESCE(wm.participants, '[]'::JSONB) AS participants
  FROM waitlist w
  LEFT JOIN (
    SELECT
      wm_inner.waitlist_id,
      jsonb_agg(jsonb_build_object(
        'member_id', wm_inner.member_id,
        'display_name', COALESCE(m.display_name, wm_inner.guest_name),
        'participant_type', wm_inner.participant_type
      ) ORDER BY wm_inner.participant_type DESC, m.display_name) AS participants
    FROM waitlist_members wm_inner
    LEFT JOIN members m ON wm_inner.member_id = m.id
    GROUP BY wm_inner.waitlist_id
  ) wm ON w.id = wm.waitlist_id
  WHERE w.status = 'waiting'
  ORDER BY w.position;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION get_active_waitlist(TIMESTAMPTZ) SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_active_waitlist TO anon;
GRANT EXECUTE ON FUNCTION get_active_waitlist TO service_role;

COMMENT ON FUNCTION get_active_waitlist IS
  'Returns active waitlist entries with participants. Safe for anon access.';

COMMIT;
