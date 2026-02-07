-- Add block_type to get_court_board RPC response
-- The blocks table has block_type (lesson, clinic, maintenance, wet, other)
-- but get_court_board was not returning it, forcing the frontend to guess
-- from block_title — which produced garbage values on edit.

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
  block_type TEXT
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
    b.block_type AS block_type
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
  'Returns court board data with consistent timestamp. Includes block_type and block_starts_at. Safe for anon access.';
