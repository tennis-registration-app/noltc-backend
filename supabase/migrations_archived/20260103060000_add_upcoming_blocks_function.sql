-- ============================================================================
-- Add get_upcoming_blocks() function for /get-board API
-- ============================================================================
--
-- Problem: The Courtboard's "Reserved Courts" panel only shows currently active
-- blocks because get_court_board() only returns blocks where starts_at <= now.
-- Future blocks scheduled for today (e.g., noon lesson) don't appear.
--
-- Solution: Add a separate function to fetch upcoming blocks for today.
-- The /get-board API will call this and return as a separate array.
--
-- ============================================================================

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
  -- Calculate end of today in the same timezone as request_time
  end_of_today := date_trunc('day', request_time) + INTERVAL '1 day' - INTERVAL '1 second';

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
    AND b.starts_at > request_time      -- Hasn't started yet
    AND b.starts_at <= end_of_today     -- Starts before end of today
  ORDER BY b.starts_at ASC, c.court_number ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION get_upcoming_blocks(TIMESTAMPTZ) SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_upcoming_blocks TO anon;
GRANT EXECUTE ON FUNCTION get_upcoming_blocks TO service_role;

COMMENT ON FUNCTION get_upcoming_blocks IS
  'Returns upcoming blocks for today (started after now, before midnight).
   Used by /get-board to populate Reserved Courts panel with future blocks.';
