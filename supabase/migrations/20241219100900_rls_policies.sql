-- Enable Row Level Security on all tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE courts ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
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

-- ===========================================
-- READ POLICIES (anon can read these)
-- ===========================================

-- Courts: Public read (needed for all displays)
CREATE POLICY "Courts are viewable by everyone"
  ON courts FOR SELECT
  USING (true);

-- Members: Public read (needed for registration lookup)
CREATE POLICY "Members are viewable by everyone"
  ON members FOR SELECT
  USING (true);

-- Accounts: Public read (needed for member lookup)
CREATE POLICY "Accounts are viewable by everyone"
  ON accounts FOR SELECT
  USING (true);

-- Devices: Public read (needed for device identification)
CREATE POLICY "Devices are viewable by everyone"
  ON devices FOR SELECT
  USING (true);

-- Sessions: Public read (needed for court board display)
CREATE POLICY "Sessions are viewable by everyone"
  ON sessions FOR SELECT
  USING (true);

-- Session participants: Public read (needed for court board display)
CREATE POLICY "Session participants are viewable by everyone"
  ON session_participants FOR SELECT
  USING (true);

-- Waitlist: Public read (needed for queue display)
CREATE POLICY "Waitlist is viewable by everyone"
  ON waitlist FOR SELECT
  USING (true);

-- Waitlist members: Public read (needed for queue display)
CREATE POLICY "Waitlist members are viewable by everyone"
  ON waitlist_members FOR SELECT
  USING (true);

-- Blocks: Public read (needed for court availability)
CREATE POLICY "Blocks are viewable by everyone"
  ON blocks FOR SELECT
  USING (true);

-- System settings: Public read (needed for prices, hours)
CREATE POLICY "System settings are viewable by everyone"
  ON system_settings FOR SELECT
  USING (true);

-- Operating hours: Public read (needed for registration validation)
CREATE POLICY "Operating hours are viewable by everyone"
  ON operating_hours FOR SELECT
  USING (true);

-- Operating hours overrides: Public read (needed for registration validation)
CREATE POLICY "Operating hours overrides are viewable by everyone"
  ON operating_hours_overrides FOR SELECT
  USING (true);

-- Transactions: Public read (needed for analytics display)
CREATE POLICY "Transactions are viewable by everyone"
  ON transactions FOR SELECT
  USING (true);

-- Exports: Public read (needed for admin export history)
CREATE POLICY "Exports are viewable by everyone"
  ON exports FOR SELECT
  USING (true);

-- Export items: Public read (needed for export details)
CREATE POLICY "Export items are viewable by everyone"
  ON export_items FOR SELECT
  USING (true);

-- Audit log: Public read (needed for admin audit trail)
CREATE POLICY "Audit log is viewable by everyone"
  ON audit_log FOR SELECT
  USING (true);

-- ===========================================
-- WRITE POLICIES (none for anon - all writes via Edge Functions)
-- ===========================================
-- No INSERT, UPDATE, or DELETE policies for anon role.
-- Edge Functions use service_role which bypasses RLS entirely.
-- This ensures all mutations go through our controlled Edge Functions.

-- ===========================================
-- COMMENTS
-- ===========================================
COMMENT ON POLICY "Courts are viewable by everyone" ON courts IS
  'All clients need to see court information for displays';

COMMENT ON POLICY "Members are viewable by everyone" ON members IS
  'Registration needs member lookup. No sensitive data exposed (pin_hash is null for MVP)';

COMMENT ON POLICY "Sessions are viewable by everyone" ON sessions IS
  'Court board displays need current and historical session data';
