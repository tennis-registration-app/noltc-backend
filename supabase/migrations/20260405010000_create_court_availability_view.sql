-- ============================================================================
-- MIGRATION: Create court_availability_view and enhance active_sessions_view
--
-- get-court-status Edge Function queries two views:
--   1. active_sessions_view  — needs session_id, minutes_remaining,
--                              participant_names, sort_order (not in baseline)
--   2. court_availability_view — does not exist yet
--
-- active_sessions_view is enhanced with CREATE OR REPLACE VIEW, preserving
-- all existing columns in their original order and adding 4 new columns at
-- the end. Fully backward compatible — get_court_board RPC is unaffected.
-- ============================================================================

-- ── Step 1: Enhance active_sessions_view ────────────────────────────────────
--
-- Adds: session_id (alias for id), minutes_remaining (from now()),
--       participant_names (text[] via correlated subquery), sort_order.
-- Existing columns (id through is_tournament) are preserved in order.

CREATE OR REPLACE VIEW active_sessions_view AS
SELECT
  s.id,
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id,
  s.is_tournament,
  -- Additional columns for get-court-status
  s.id AS session_id,
  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (s.scheduled_end_at - NOW())) / 60))::INT AS minutes_remaining,
  (
    SELECT COALESCE(
      ARRAY_AGG(
        COALESCE(m.display_name, sp2.guest_name)
        ORDER BY sp2.participant_type DESC,
                 COALESCE(m.display_name, sp2.guest_name)
      ) FILTER (WHERE COALESCE(m.display_name, sp2.guest_name) IS NOT NULL),
      ARRAY[]::TEXT[]
    )
    FROM session_participants sp2
    LEFT JOIN members m ON m.id = sp2.member_id
    WHERE sp2.session_id = s.id
  ) AS participant_names,
  c.sort_order
FROM sessions s
JOIN courts c ON c.id = s.court_id
WHERE
  s.actual_end_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1 FROM session_events se
      WHERE se.session_id = s.id
        AND se.event_type = 'END'
    )
    OR
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
  'Active sessions — no END event, or has RESTORE after END.
   Supports event-sourced lifecycle. Includes session_id alias, minutes_remaining,
   participant_names (text[]), and sort_order for use by get-court-status.';

-- ── Step 2: Create court_availability_view ───────────────────────────────────
--
-- Returns one row per active court with a computed status field.
-- Status precedence: blocked > overtime > occupied > available.

CREATE OR REPLACE VIEW court_availability_view AS
SELECT
  c.id AS court_id,
  c.court_number,
  c.name AS court_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM blocks b
      WHERE b.court_id = c.id
        AND b.cancelled_at IS NULL
        AND b.starts_at <= NOW()
        AND b.ends_at > NOW()
    ) THEN 'blocked'
    WHEN EXISTS (
      SELECT 1 FROM active_sessions_view s
      WHERE s.court_id = c.id
        AND s.scheduled_end_at < NOW()
    ) THEN 'overtime'
    WHEN EXISTS (
      SELECT 1 FROM active_sessions_view s
      WHERE s.court_id = c.id
    ) THEN 'occupied'
    ELSE 'available'
  END::TEXT AS status,
  c.sort_order
FROM courts c
WHERE c.is_active = true
ORDER BY c.sort_order;

GRANT SELECT ON court_availability_view TO anon;
GRANT SELECT ON court_availability_view TO service_role;

COMMENT ON VIEW court_availability_view IS
  'One row per active court. Status: blocked > overtime > occupied > available.
   Used by get-court-status Edge Function.';
