-- Frequent Partners Cache Table
-- Pre-computed frequent partners for fast lookup

CREATE TABLE frequent_partners_cache (
  member_id uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  partners jsonb NOT NULL DEFAULT '[]',
  computed_at timestamptz NOT NULL DEFAULT NOW()
);

-- Index for finding stale records
CREATE INDEX idx_fpc_computed_at ON frequent_partners_cache(computed_at);

-- Only service_role can access (edge functions)
GRANT SELECT, INSERT, UPDATE, DELETE ON frequent_partners_cache TO service_role;

-- Set-based refresh function (efficient for 500+ members)
CREATE OR REPLACE FUNCTION refresh_frequent_partners_cache()
RETURNS TABLE (members_processed bigint, duration_ms int) AS $$
DECLARE
  start_ts timestamptz := clock_timestamp();
  processed bigint;
BEGIN
  -- Compute and upsert all active members in one pass
  WITH active_members AS (
    -- Members who played in last 90 days
    SELECT DISTINCT sp.member_id
    FROM session_participants sp
    JOIN sessions s ON s.id = sp.session_id
    WHERE sp.member_id IS NOT NULL
      AND s.started_at >= NOW() - INTERVAL '90 days'
  ),
  partner_counts AS (
    -- Count co-plays for all active members at once
    SELECT
      me.member_id AS for_member,
      co.member_id AS partner_id,
      m.display_name,
      a.member_number,
      COUNT(DISTINCT me.session_id) AS play_count,
      bool_or(s.started_at >= NOW() - INTERVAL '6 months') AS is_recent
    FROM session_participants me
    JOIN session_participants co
      ON co.session_id = me.session_id
      AND co.member_id IS NOT NULL
      AND co.member_id <> me.member_id
    JOIN sessions s ON s.id = me.session_id
    JOIN members m ON m.id = co.member_id
    JOIN accounts a ON m.account_id = a.id
    WHERE me.member_id IN (SELECT member_id FROM active_members)
    GROUP BY me.member_id, co.member_id, m.display_name, a.member_number
  ),
  ranked_partners AS (
    -- Rank partners per member, limit to top 10
    SELECT
      for_member,
      partner_id,
      display_name,
      member_number,
      play_count,
      is_recent,
      ROW_NUMBER() OVER (
        PARTITION BY for_member
        ORDER BY is_recent DESC, play_count DESC, display_name ASC
      ) AS rank
    FROM partner_counts
  ),
  aggregated AS (
    -- Aggregate to JSON per member
    SELECT
      for_member AS member_id,
      jsonb_agg(
        jsonb_build_object(
          'member_id', partner_id,
          'display_name', display_name,
          'member_number', member_number,
          'play_count', play_count,
          'is_recent', is_recent
        ) ORDER BY rank
      ) AS partners
    FROM ranked_partners
    WHERE rank <= 10
    GROUP BY for_member
  )
  -- Upsert all at once
  INSERT INTO frequent_partners_cache (member_id, partners, computed_at)
  SELECT member_id, partners, NOW()
  FROM aggregated
  ON CONFLICT (member_id) DO UPDATE SET
    partners = EXCLUDED.partners,
    computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS processed = ROW_COUNT;

  members_processed := processed;
  duration_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - start_ts)::int;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Single member refresh (for future incremental updates)
CREATE OR REPLACE FUNCTION refresh_single_member_cache(p_member_id uuid)
RETURNS void AS $$
BEGIN
  WITH partner_counts AS (
    SELECT
      co.member_id AS partner_id,
      m.display_name,
      a.member_number,
      COUNT(DISTINCT sp.session_id) AS play_count,
      bool_or(s.started_at >= NOW() - INTERVAL '6 months') AS is_recent
    FROM session_participants sp
    JOIN session_participants co
      ON co.session_id = sp.session_id
      AND co.member_id IS NOT NULL
      AND co.member_id <> sp.member_id
    JOIN sessions s ON s.id = sp.session_id
    JOIN members m ON m.id = co.member_id
    JOIN accounts a ON m.account_id = a.id
    WHERE sp.member_id = p_member_id
    GROUP BY co.member_id, m.display_name, a.member_number
  ),
  ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (ORDER BY is_recent DESC, play_count DESC, display_name ASC) AS rank
    FROM partner_counts
  )
  INSERT INTO frequent_partners_cache (member_id, partners, computed_at)
  SELECT
    p_member_id,
    COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'member_id', partner_id,
          'display_name', display_name,
          'member_number', member_number,
          'play_count', play_count,
          'is_recent', is_recent
        ) ORDER BY rank
      ) FROM ranked WHERE rank <= 10),
      '[]'::jsonb
    ),
    NOW()
  ON CONFLICT (member_id) DO UPDATE SET
    partners = EXCLUDED.partners,
    computed_at = EXCLUDED.computed_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION refresh_frequent_partners_cache() TO service_role;
GRANT EXECUTE ON FUNCTION refresh_single_member_cache(uuid) TO service_role;
