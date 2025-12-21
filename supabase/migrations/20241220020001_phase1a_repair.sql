-- ============================================================================
-- PHASE 1A REPAIR: Complete failed migration
-- Applies sections that failed due to "settings" -> "system_settings" typo
-- ============================================================================

BEGIN;

-- 1.12 System Settings - PUBLIC (safe to expose)
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon can read system_settings" ON system_settings;
DROP POLICY IF EXISTS "Service role full access to system_settings" ON system_settings;
CREATE POLICY "Anon can read system_settings" ON system_settings
  FOR SELECT TO anon USING (true);
CREATE POLICY "Service role full access to system_settings" ON system_settings
  FOR ALL TO service_role USING (true);


-- ============================================================================
-- SECTION 2: SESSION_EVENTS TABLE (Append-Only Session Lifecycle)
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('START', 'END', 'EXTEND')),
  event_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id);

CREATE INDEX IF NOT EXISTS idx_session_events_type
  ON session_events(event_type);

CREATE INDEX IF NOT EXISTS idx_session_events_created
  ON session_events(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_end_per_session
  ON session_events(session_id)
  WHERE event_type = 'END';

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny anon access to session_events" ON session_events;
DROP POLICY IF EXISTS "Service role full access to session_events" ON session_events;
CREATE POLICY "Deny anon access to session_events" ON session_events
  FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to session_events" ON session_events
  FOR ALL TO service_role USING (true);

COMMENT ON COLUMN members.pin_hash IS
  'FUTURE: PIN verification not implemented in MVP. Column exists for future use. Not exposed via any API or view.';


-- ============================================================================
-- SECTION 3: ACTIVE_SESSIONS_VIEW
-- ============================================================================

DROP VIEW IF EXISTS active_sessions_view;
CREATE OR REPLACE VIEW active_sessions_view AS
SELECT
  s.id,
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id
FROM sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM session_events se
  WHERE se.session_id = s.id AND se.event_type = 'END'
);

COMMENT ON VIEW active_sessions_view IS
  'Internal view for Edge Functions only. Not accessible to anon role due to underlying table RLS. Use get_court_board() function for public access.';


-- ============================================================================
-- SECTION 4: BOARD_CHANGE_SIGNALS TABLE (Lightweight Realtime)
-- ============================================================================

CREATE TABLE IF NOT EXISTS board_change_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_type TEXT NOT NULL CHECK (change_type IN ('session', 'waitlist', 'block')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_change_signals_created
  ON board_change_signals(created_at);

ALTER TABLE board_change_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon can subscribe to signals" ON board_change_signals;
DROP POLICY IF EXISTS "Service role full access to board_change_signals" ON board_change_signals;
CREATE POLICY "Anon can subscribe to signals" ON board_change_signals
  FOR SELECT TO anon USING (true);
CREATE POLICY "Service role full access to board_change_signals" ON board_change_signals
  FOR ALL TO service_role USING (true);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE board_change_signals;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;


-- ============================================================================
-- SECTION 5: SIGNAL EMISSION WITH BOUNDED CLEANUP
-- ============================================================================

CREATE OR REPLACE FUNCTION emit_board_signal()
RETURNS TRIGGER AS $$
DECLARE
  signal_count INT;
  max_signals CONSTANT INT := 100;
BEGIN
  INSERT INTO board_change_signals (change_type) VALUES (TG_ARGV[0]);

  SELECT COUNT(*) INTO signal_count FROM board_change_signals;

  IF signal_count > max_signals THEN
    DELETE FROM board_change_signals
    WHERE id NOT IN (
      SELECT id FROM board_change_signals
      ORDER BY created_at DESC
      LIMIT max_signals / 2
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION emit_board_signal() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS session_events_signal ON session_events;
CREATE TRIGGER session_events_signal
  AFTER INSERT ON session_events
  FOR EACH ROW EXECUTE FUNCTION emit_board_signal('session');

DROP TRIGGER IF EXISTS waitlist_signal ON waitlist;
CREATE TRIGGER waitlist_signal
  AFTER INSERT OR UPDATE OR DELETE ON waitlist
  FOR EACH ROW EXECUTE FUNCTION emit_board_signal('waitlist');

DROP TRIGGER IF EXISTS blocks_signal ON blocks;
CREATE TRIGGER blocks_signal
  AFTER INSERT OR UPDATE OR DELETE ON blocks
  FOR EACH ROW EXECUTE FUNCTION emit_board_signal('block');


-- ============================================================================
-- SECTION 6: GET_COURT_BOARD() SQL FUNCTION
-- ============================================================================

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
  block_ends_at TIMESTAMPTZ
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
    b.ends_at AS block_ends_at
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

GRANT EXECUTE ON FUNCTION get_court_board TO anon;
GRANT EXECUTE ON FUNCTION get_court_board TO service_role;

COMMENT ON FUNCTION get_court_board IS
  'Returns court board data with consistent timestamp. Safe for anon access - returns sanitized data only. member_number intentionally excluded for privacy.';


-- ============================================================================
-- SECTION 7: GET_ACTIVE_WAITLIST() SQL FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION get_active_waitlist(request_time TIMESTAMPTZ DEFAULT NOW())
RETURNS TABLE (
  id UUID,
  "position" INT,
  group_type TEXT,
  joined_at TIMESTAMPTZ,
  minutes_waiting INT,
  participants JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.position,
    w.group_type,
    w.joined_at,
    CEIL(EXTRACT(EPOCH FROM (request_time - w.joined_at)) / 60)::INT AS minutes_waiting,
    w.participants
  FROM waitlist w
  WHERE w.status = 'waiting'
  ORDER BY w.position;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION get_active_waitlist(TIMESTAMPTZ) SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_active_waitlist TO anon;
GRANT EXECUTE ON FUNCTION get_active_waitlist TO service_role;

COMMENT ON FUNCTION get_active_waitlist IS
  'Returns active waitlist entries with consistent timestamp. Safe for anon access.';


-- ============================================================================
-- SECTION 8: CLEANUP FUNCTION (Manual/Scheduled Use)
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_signals(max_age INTERVAL DEFAULT '1 hour')
RETURNS INT AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM board_change_signals
  WHERE created_at < NOW() - max_age;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION cleanup_old_signals(INTERVAL) SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION cleanup_old_signals TO service_role;

COMMENT ON FUNCTION cleanup_old_signals IS
  'Manual/scheduled cleanup of old signals. Called from Edge Function cron or pg_cron.';

COMMIT;
