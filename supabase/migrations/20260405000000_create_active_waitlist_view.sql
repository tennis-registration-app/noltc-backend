-- ============================================================================
-- VIEW: active_waitlist_view
-- Used by get-waitlist Edge Function to return the current waitlist with
-- participant names and wait time in minutes.
-- ============================================================================

CREATE OR REPLACE VIEW active_waitlist_view AS
SELECT
  w.id AS waitlist_id,
  w.position,
  w.group_type,
  w.joined_at,
  CEIL(EXTRACT(EPOCH FROM (NOW() - w.joined_at)) / 60)::INT AS minutes_waiting,
  COALESCE(
    ARRAY_AGG(
      COALESCE(m.display_name, wm.guest_name)
      ORDER BY wm.participant_type DESC, COALESCE(m.display_name, wm.guest_name)
    ) FILTER (WHERE COALESCE(m.display_name, wm.guest_name) IS NOT NULL),
    ARRAY[]::TEXT[]
  ) AS participant_names
FROM waitlist w
LEFT JOIN waitlist_members wm ON wm.waitlist_id = w.id
LEFT JOIN members m ON m.id = wm.member_id
WHERE w.status = 'waiting'
GROUP BY w.id, w.position, w.group_type, w.joined_at
ORDER BY w.position;

GRANT SELECT ON active_waitlist_view TO anon;
GRANT SELECT ON active_waitlist_view TO service_role;

COMMENT ON VIEW active_waitlist_view IS
  'Active waitlist entries with participant display names and minutes waiting. Used by get-waitlist Edge Function.';
