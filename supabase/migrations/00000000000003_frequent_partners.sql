-- Frequent Partners Feature
-- Returns members that a given member has played with most frequently

-- Function to get frequent partners for a member
CREATE OR REPLACE FUNCTION get_frequent_partners(p_member_id uuid)
RETURNS TABLE (
  member_id uuid,
  display_name text,
  member_number text,
  play_count bigint,
  is_recent boolean
) AS $$
BEGIN
  RETURN QUERY
  WITH recent AS (
    SELECT
      co.member_id,
      m.display_name,
      a.member_number,
      COUNT(DISTINCT me.session_id)::bigint AS play_count,
      true AS is_recent
    FROM session_participants me
    JOIN session_participants co
      ON co.session_id = me.session_id
     AND co.member_id IS NOT NULL
     AND co.member_id <> me.member_id
    JOIN sessions s ON s.id = me.session_id
    JOIN members m ON m.id = co.member_id
    JOIN accounts a ON m.account_id = a.id
    WHERE me.member_id = p_member_id
      AND s.started_at >= NOW() - INTERVAL '6 months'
    GROUP BY co.member_id, m.display_name, a.member_number
  ),
  older AS (
    SELECT
      co.member_id,
      m.display_name,
      a.member_number,
      COUNT(DISTINCT me.session_id)::bigint AS play_count,
      false AS is_recent
    FROM session_participants me
    JOIN session_participants co
      ON co.session_id = me.session_id
     AND co.member_id IS NOT NULL
     AND co.member_id <> me.member_id
    JOIN sessions s ON s.id = me.session_id
    JOIN members m ON m.id = co.member_id
    JOIN accounts a ON m.account_id = a.id
    WHERE me.member_id = p_member_id
      AND s.started_at < NOW() - INTERVAL '6 months'
      AND co.member_id NOT IN (SELECT r.member_id FROM recent r)
    GROUP BY co.member_id, m.display_name, a.member_number
  )
  SELECT * FROM recent
  UNION ALL
  SELECT * FROM older
  ORDER BY is_recent DESC, play_count DESC, display_name ASC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add composite index for better performance on the join
CREATE INDEX IF NOT EXISTS idx_session_participants_member_session
ON session_participants (member_id, session_id);

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_frequent_partners(uuid) TO service_role;
