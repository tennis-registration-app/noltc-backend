-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE courts ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_hours_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_change_signals ENABLE ROW LEVEL SECURITY;

-- Deny anon access to sensitive tables (access via Edge Functions with service_role)
CREATE POLICY "Deny anon access to accounts" ON accounts FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to accounts" ON accounts FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to members" ON members FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to members" ON members FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon direct access to courts" ON courts FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to courts" ON courts FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to devices" ON devices FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to devices" ON devices FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon direct access to sessions" ON sessions FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to sessions" ON sessions FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to session_participants" ON session_participants FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to session_participants" ON session_participants FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to session_events" ON session_events FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to session_events" ON session_events FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon direct access to waitlist" ON waitlist FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to waitlist" ON waitlist FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to waitlist_members" ON waitlist_members FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to waitlist_members" ON waitlist_members FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon direct access to blocks" ON blocks FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to blocks" ON blocks FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to transactions" ON transactions FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to transactions" ON transactions FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to exports" ON exports FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to exports" ON exports FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to export_items" ON export_items FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to export_items" ON export_items FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to audit_log" ON audit_log FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to audit_log" ON audit_log FOR ALL TO service_role USING (true);

CREATE POLICY "Deny anon access to location_tokens" ON location_tokens FOR SELECT TO anon USING (false);
CREATE POLICY "Service role full access to location_tokens" ON location_tokens FOR ALL TO service_role USING (true);

-- Public read access for safe tables
CREATE POLICY "Anon can read system_settings" ON system_settings FOR SELECT TO anon USING (true);
CREATE POLICY "Service role full access to system_settings" ON system_settings FOR ALL TO service_role USING (true);

CREATE POLICY "Anon can read operating hours" ON operating_hours FOR SELECT TO anon USING (true);
CREATE POLICY "Service role full access to operating_hours" ON operating_hours FOR ALL TO service_role USING (true);

CREATE POLICY "Anon can read operating_hours_overrides" ON operating_hours_overrides FOR SELECT TO anon USING (true);
CREATE POLICY "Service role full access to operating_hours_overrides" ON operating_hours_overrides FOR ALL TO service_role USING (true);

CREATE POLICY "Anon can subscribe to signals" ON board_change_signals FOR SELECT TO anon USING (true);
CREATE POLICY "Service role full access to board_change_signals" ON board_change_signals FOR ALL TO service_role USING (true);

-- ============================================================================
-- REALTIME PUBLICATIONS
-- ============================================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE board_change_signals;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE session_participants;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE waitlist;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE waitlist_members;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE blocks;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE courts;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE system_settings;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE operating_hours;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE operating_hours_overrides;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
