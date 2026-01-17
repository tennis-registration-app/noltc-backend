-- RPC function to search session history with proper filtering
-- Returns sessions with aggregated participants in one optimized query

CREATE OR REPLACE FUNCTION search_session_history(
  p_member_name TEXT DEFAULT NULL,
  p_date_start DATE DEFAULT NULL,
  p_date_end DATE DEFAULT NULL,
  p_court_number INT DEFAULT NULL,
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  court_id UUID,
  court_number INT,
  session_type TEXT,
  duration_minutes INT,
  started_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  actual_end_at TIMESTAMPTZ,
  end_reason TEXT,
  participants JSONB
) AS $$
BEGIN
  RETURN QUERY
  WITH matching_sessions AS (
    SELECT s.id
    FROM sessions s
    JOIN courts c ON c.id = s.court_id
    WHERE s.actual_end_at IS NOT NULL
      -- Date filters
      AND (p_date_start IS NULL OR s.started_at >= p_date_start::timestamptz)
      AND (p_date_end IS NULL OR s.started_at < (p_date_end + INTERVAL '1 day')::timestamptz)
      -- Court filter
      AND (p_court_number IS NULL OR c.court_number = p_court_number)
      -- Member name filter using EXISTS (efficient, no duplicates)
      AND (p_member_name IS NULL OR EXISTS (
        SELECT 1 FROM session_participants sp
        LEFT JOIN members m ON m.id = sp.member_id
        WHERE sp.session_id = s.id
          AND (
            m.display_name ILIKE '%' || p_member_name || '%'
            OR sp.guest_name ILIKE '%' || p_member_name || '%'
          )
      ))
    ORDER BY s.started_at DESC
    LIMIT p_limit
  )
  SELECT
    s.id,
    s.court_id,
    c.court_number,
    s.session_type,
    s.duration_minutes,
    s.started_at,
    s.scheduled_end_at,
    s.actual_end_at,
    s.end_reason,
    COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'member_id', sp.member_id,
          'display_name', COALESCE(m.display_name, sp.guest_name),
          'member_number', a.member_number,
          'participant_type', sp.participant_type,
          'guest_name', sp.guest_name
        ) ORDER BY sp.participant_type, COALESCE(m.display_name, sp.guest_name)
      )
      FROM session_participants sp
      LEFT JOIN members m ON m.id = sp.member_id
      LEFT JOIN accounts a ON a.id = m.account_id
      WHERE sp.session_id = s.id
      ), '[]'::jsonb
    ) AS participants
  FROM matching_sessions ms
  JOIN sessions s ON s.id = ms.id
  JOIN courts c ON c.id = s.court_id
  ORDER BY s.started_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant execute to service role
GRANT EXECUTE ON FUNCTION search_session_history TO service_role;

-- Add index on started_at if not exists (for ORDER BY performance)
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);

-- Add comment
COMMENT ON FUNCTION search_session_history IS
  'Search session history with optional filters for member name, date range, and court number. Returns sessions with aggregated participants.';
