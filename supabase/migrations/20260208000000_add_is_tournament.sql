-- Add is_tournament flag to sessions table.
-- Tournament matches play until completion and their overtime courts
-- are never selectable by other groups.

ALTER TABLE sessions
  ADD COLUMN is_tournament BOOLEAN NOT NULL DEFAULT false;

-- Recreate active_sessions_view to include is_tournament.
-- The view explicitly lists columns, so new columns are not automatically included.
CREATE OR REPLACE VIEW active_sessions_view AS
SELECT
  s.id,
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id,
  s.is_tournament
FROM sessions s
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

-- Update get_court_board RPC to include is_tournament in response.
-- Must DROP first because RETURNS TABLE signature is changing.

DROP FUNCTION IF EXISTS get_court_board(TIMESTAMPTZ, INT);

CREATE OR REPLACE FUNCTION get_court_board(
  request_time TIMESTAMPTZ DEFAULT NOW(),
  filter_court_number INT DEFAULT NULL
)
RETURNS TABLE (
  court_id UUID,
  court_number INT,
  status TEXT,
  session_id UUID,
  started_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  session_type TEXT,
  minutes_remaining INT,
  participants JSONB,
  block_id UUID,
  block_title TEXT,
  block_starts_at TIMESTAMPTZ,
  block_ends_at TIMESTAMPTZ,
  block_type TEXT,
  is_tournament BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS court_id,
    c.court_number,
    CASE
      WHEN b.id IS NOT NULL THEN 'blocked'
      WHEN s.id IS NULL THEN 'available'
      WHEN s.scheduled_end_at < request_time THEN 'overtime'
      ELSE 'occupied'
    END::TEXT AS status,
    s.id AS session_id,
    s.started_at,
    s.scheduled_end_at,
    s.session_type,
    CASE
      WHEN s.id IS NULL THEN NULL
      ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (s.scheduled_end_at - request_time)) / 60))::INT
    END AS minutes_remaining,
    COALESCE(sp.participants, '[]'::JSONB) AS participants,
    b.id AS block_id,
    b.title AS block_title,
    b.starts_at AS block_starts_at,
    b.ends_at AS block_ends_at,
    b.block_type AS block_type,
    COALESCE(s.is_tournament, false) AS is_tournament
  FROM courts c
  LEFT JOIN active_sessions_view s ON c.id = s.court_id
  LEFT JOIN (
    SELECT
      spart.session_id,
      jsonb_agg(jsonb_build_object(
        'member_id', spart.member_id,
        'display_name', COALESCE(m.display_name, spart.guest_name),
        'participant_type', spart.participant_type
      ) ORDER BY spart.participant_type DESC, m.display_name) AS participants
    FROM session_participants spart
    LEFT JOIN members m ON spart.member_id = m.id
    GROUP BY spart.session_id
  ) sp ON s.id = sp.session_id
  LEFT JOIN blocks b ON c.id = b.court_id
    AND b.cancelled_at IS NULL
    AND b.starts_at <= request_time
    AND b.ends_at > request_time
  WHERE (filter_court_number IS NULL OR c.court_number = filter_court_number)
  ORDER BY c.court_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION get_court_board(TIMESTAMPTZ, INT) SET search_path = public, pg_temp;

COMMENT ON FUNCTION get_court_board IS
  'Returns court board data with consistent timestamp. Includes block_type, block_starts_at, and is_tournament. Safe for anon access.';
