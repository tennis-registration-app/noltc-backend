-- Fix get_upcoming_blocks to use Central Time day boundaries
-- Previously used UTC which excluded blocks after 6pm Central (midnight UTC)

CREATE OR REPLACE FUNCTION get_upcoming_blocks(
  request_time TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  block_id UUID,
  court_id UUID,
  court_number INT,
  block_type TEXT,
  title TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ
) AS $$
DECLARE
  end_of_today TIMESTAMPTZ;
BEGIN
  end_of_today := (date_trunc('day', request_time AT TIME ZONE 'America/Chicago') + INTERVAL '1 day' - INTERVAL '1 second') AT TIME ZONE 'America/Chicago';

  RETURN QUERY
  SELECT
    b.id AS block_id,
    b.court_id,
    c.court_number,
    b.block_type,
    b.title,
    b.starts_at,
    b.ends_at
  FROM blocks b
  JOIN courts c ON b.court_id = c.id
  WHERE b.cancelled_at IS NULL
    AND b.starts_at > request_time
    AND b.starts_at <= end_of_today
  ORDER BY b.starts_at ASC, c.court_number ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
