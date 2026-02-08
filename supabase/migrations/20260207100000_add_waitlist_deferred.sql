-- Add deferred flag to waitlist table
-- A deferred group is still 'waiting' but skipped by CTA/You're Up logic
ALTER TABLE waitlist
  ADD COLUMN deferred boolean NOT NULL DEFAULT false;

-- Recreate get_active_waitlist to include deferred column
DROP FUNCTION IF EXISTS get_active_waitlist(TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION get_active_waitlist(request_time TIMESTAMPTZ DEFAULT NOW())
RETURNS TABLE (
  id UUID,
  "position" INT,
  group_type TEXT,
  joined_at TIMESTAMPTZ,
  minutes_waiting INT,
  participants JSONB,
  deferred BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.position,
    w.group_type,
    w.joined_at,
    CEIL(EXTRACT(EPOCH FROM (request_time - w.joined_at)) / 60)::INT AS minutes_waiting,
    COALESCE(wm.participants, '[]'::JSONB) AS participants,
    w.deferred
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
  'Returns active waitlist entries with participants and deferred flag. Safe for anon access.';
