-- ============================================================================
-- NOLTC Tennis Court Registration System - Baseline Schema
-- ============================================================================
-- Consolidated from 43 migrations into a single baseline.
-- Created: 2026-01-05
-- ============================================================================

-- ============================================================================
-- EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- TABLES (in dependency order)
-- ============================================================================

-- Accounts (billing accounts, ~750)
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_number text UNIQUE NOT NULL,
  account_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_member_number ON accounts(member_number);
CREATE INDEX idx_accounts_status ON accounts(status);

-- Courts (12 courts)
CREATE TABLE courts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_number integer UNIQUE NOT NULL CHECK (court_number > 0),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_courts_sort_order ON courts(sort_order);

-- Devices (kiosk, passive displays, admin, mobile)
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type text NOT NULL CHECK (device_type IN ('kiosk', 'passive_display', 'admin', 'mobile')),
  device_name text NOT NULL,
  device_token text UNIQUE NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_device_type ON devices(device_type);
CREATE INDEX idx_devices_device_token ON devices(device_token);

-- Members (individual people, ~2,500)
CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  pin_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_members_account_id ON members(account_id);
CREATE INDEX idx_members_display_name ON members(display_name);
CREATE INDEX idx_members_status ON members(status);

COMMENT ON COLUMN members.pin_hash IS
  'FUTURE: PIN verification not implemented in MVP. Column exists for future use.';

-- Sessions (court occupancy records)
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  session_type text NOT NULL CHECK (session_type IN ('singles', 'doubles')),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  scheduled_end_at timestamptz NOT NULL,
  actual_end_at timestamptz NULL,
  end_reason text NULL CHECK (end_reason IN ('cleared', 'observed_cleared', 'admin_override', 'overtime_takeover', 'auto_cleared')),
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  ended_by_device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_end_time CHECK (actual_end_at IS NULL OR actual_end_at >= started_at),
  CONSTRAINT end_reason_required CHECK ((actual_end_at IS NULL AND end_reason IS NULL) OR (actual_end_at IS NOT NULL AND end_reason IS NOT NULL))
);

CREATE INDEX idx_sessions_court_active ON sessions(court_id, actual_end_at) WHERE actual_end_at IS NULL;
CREATE INDEX idx_sessions_started_at ON sessions(started_at);
CREATE INDEX idx_sessions_court_id ON sessions(court_id);

-- Session participants
CREATE TABLE session_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  member_id uuid NULL REFERENCES members(id) ON DELETE RESTRICT,
  guest_name text NULL,
  participant_type text NOT NULL CHECK (participant_type IN ('member', 'guest')),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_participant CHECK (
    (participant_type = 'member' AND member_id IS NOT NULL AND guest_name IS NULL) OR
    (participant_type = 'guest' AND member_id IS NULL AND guest_name IS NOT NULL)
  )
);

CREATE INDEX idx_session_participants_session_id ON session_participants(session_id);
CREATE INDEX idx_session_participants_member_id ON session_participants(member_id);
CREATE INDEX idx_session_participants_account_id ON session_participants(account_id);

-- Session events (append-only lifecycle events)
CREATE TABLE session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('START', 'END', 'EXTEND', 'RESTORE')),
  event_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX idx_session_events_session ON session_events(session_id);
CREATE INDEX idx_session_events_type ON session_events(event_type);
CREATE INDEX idx_session_events_created ON session_events(created_at);

COMMENT ON TABLE session_events IS
  'Event-sourced session lifecycle. Supports multiple END/RESTORE cycles.
   A session is active if it has no END events, or its most recent RESTORE
   is newer than its most recent END.';

-- Waitlist
CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_type text NOT NULL CHECK (group_type IN ('singles', 'doubles')),
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'paused', 'assigned', 'cancelled')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz NULL,
  assigned_session_id uuid NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_waitlist_status_position ON waitlist(status, position) WHERE status = 'waiting';
CREATE INDEX idx_waitlist_joined_at ON waitlist(joined_at);

-- Waitlist members
CREATE TABLE waitlist_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_id uuid NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
  member_id uuid NULL REFERENCES members(id) ON DELETE RESTRICT,
  guest_name text NULL,
  participant_type text NOT NULL CHECK (participant_type IN ('member', 'guest')),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_waitlist_participant CHECK (
    (participant_type = 'member' AND member_id IS NOT NULL AND guest_name IS NULL) OR
    (participant_type = 'guest' AND member_id IS NULL AND guest_name IS NOT NULL)
  )
);

CREATE INDEX idx_waitlist_members_waitlist_id ON waitlist_members(waitlist_id);
CREATE INDEX idx_waitlist_members_member_id ON waitlist_members(member_id);

-- Blocks (lessons, clinics, maintenance, wet courts)
CREATE TABLE blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  block_type text NOT NULL CHECK (block_type IN ('lesson', 'clinic', 'maintenance', 'wet', 'other')),
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  is_recurring boolean NOT NULL DEFAULT false,
  recurrence_rule text NULL,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  CONSTRAINT valid_block_times CHECK (ends_at > starts_at),
  CONSTRAINT recurrence_rule_required CHECK ((is_recurring = false AND recurrence_rule IS NULL) OR (is_recurring = true AND recurrence_rule IS NOT NULL))
);

CREATE INDEX idx_blocks_court_time ON blocks(court_id, starts_at, ends_at) WHERE cancelled_at IS NULL;
CREATE INDEX idx_blocks_starts_at ON blocks(starts_at);

-- Transactions (financial records)
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  transaction_type text NOT NULL CHECK (transaction_type IN ('guest_fee', 'ball_purchase', 'reversal')),
  amount_cents integer NOT NULL,
  description text NOT NULL,
  session_id uuid NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  related_transaction_id uuid NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NULL
);

CREATE INDEX idx_transactions_account_id ON transactions(account_id, created_at);
CREATE INDEX idx_transactions_session_id ON transactions(session_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_type ON transactions(transaction_type);
CREATE UNIQUE INDEX idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN transactions.idempotency_key IS
  'Client-provided key to prevent duplicate transactions on retry';

-- Exports
CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_type text NOT NULL CHECK (export_type IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  file_path text NULL,
  record_count integer NULL,
  date_range_start timestamptz NOT NULL,
  date_range_end timestamptz NOT NULL,
  created_by_device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_exports_status ON exports(status);
CREATE INDEX idx_exports_created_at ON exports(created_at);

-- Export items
CREATE TABLE export_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_export_transaction UNIQUE (export_id, transaction_id)
);

CREATE INDEX idx_export_items_export_id ON export_items(export_id);
CREATE INDEX idx_export_items_transaction_id ON export_items(transaction_id);

-- Audit log (append-only)
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT,
  device_type text NULL,
  initiated_by text NOT NULL DEFAULT 'user' CHECK (initiated_by IN ('user', 'ai_assistant', 'system')),
  member_id uuid NULL REFERENCES members(id) ON DELETE RESTRICT,
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  request_data jsonb NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  error_message text NULL,
  ip_address text NULL,
  geofence_status text NULL CHECK (geofence_status IN ('validated', 'failed', 'not_required')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_device ON audit_log(device_id, created_at);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_outcome ON audit_log(outcome);
CREATE INDEX idx_audit_log_initiated_by ON audit_log(initiated_by);

-- System settings
CREATE TABLE system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT
);

-- Operating hours
CREATE TABLE operating_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_of_week integer NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  is_closed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_day_of_week UNIQUE (day_of_week),
  CONSTRAINT valid_hours CHECK (is_closed = true OR closes_at > opens_at)
);

-- Operating hours overrides
CREATE TABLE operating_hours_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date UNIQUE NOT NULL,
  opens_at time NULL,
  closes_at time NULL,
  is_closed boolean NOT NULL DEFAULT false,
  reason text NULL,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_override CHECK (is_closed = true OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at))
);

CREATE INDEX idx_operating_hours_overrides_date ON operating_hours_overrides(date);

-- Location tokens (QR-based geofence bypass)
CREATE TABLE location_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(32) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by_device_id UUID REFERENCES devices(id),
  used_at TIMESTAMPTZ,
  used_by_member_id UUID REFERENCES members(id),
  used_by_device_id UUID REFERENCES devices(id)
);

CREATE INDEX idx_location_tokens_token ON location_tokens(token);
CREATE INDEX idx_location_tokens_expires_at ON location_tokens(expires_at);

COMMENT ON TABLE location_tokens IS 'Short-lived tokens for QR-based location verification when GPS is unavailable';

-- Board change signals (lightweight Realtime triggers)
CREATE TABLE board_change_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_type TEXT NOT NULL CHECK (change_type IN ('session', 'waitlist', 'block')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_board_change_signals_created ON board_change_signals(created_at);

-- ============================================================================
-- TRIGGER FUNCTION: update_updated_at_column
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_members_updated_at BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_system_settings_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_operating_hours_updated_at BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEW: active_sessions_view
-- ============================================================================
CREATE VIEW active_sessions_view AS
SELECT
  s.id,
  s.court_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  s.created_by_device_id
FROM sessions s
WHERE
  s.actual_end_at IS NULL
  AND (
    -- Case 1: No END event exists (normal active session)
    NOT EXISTS (
      SELECT 1 FROM session_events se
      WHERE se.session_id = s.id
      AND se.event_type = 'END'
    )
    OR
    -- Case 2: A RESTORE event exists that is newer than the last END event
    EXISTS (
      SELECT 1 FROM session_events restore_evt
      WHERE restore_evt.session_id = s.id
      AND restore_evt.event_type = 'RESTORE'
      AND restore_evt.created_at > (
        SELECT MAX(end_evt.created_at)
        FROM session_events end_evt
        WHERE end_evt.session_id = s.id
        AND end_evt.event_type = 'END'
      )
    )
  );

COMMENT ON VIEW active_sessions_view IS
  'Active sessions - no END event, or has RESTORE after END.
   Supports event-sourced lifecycle where RESTORE compensates for END.';

-- ============================================================================
-- FUNCTION: emit_board_signal (trigger for Realtime)
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

-- Signal triggers
CREATE TRIGGER session_events_signal
  AFTER INSERT ON session_events
  FOR EACH ROW EXECUTE FUNCTION emit_board_signal('session');

CREATE TRIGGER waitlist_signal
  AFTER INSERT OR UPDATE OR DELETE ON waitlist
  FOR EACH ROW EXECUTE FUNCTION emit_board_signal('waitlist');

CREATE TRIGGER blocks_signal
  AFTER INSERT OR UPDATE OR DELETE ON blocks
  FOR EACH ROW EXECUTE FUNCTION emit_board_signal('block');

-- ============================================================================
-- FUNCTION: get_court_board
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
  block_starts_at TIMESTAMPTZ,
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
    b.starts_at AS block_starts_at,
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
  'Returns court board data with consistent timestamp. Includes block_starts_at. Safe for anon access.';

-- ============================================================================
-- FUNCTION: get_active_waitlist
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
    COALESCE(wm.participants, '[]'::JSONB) AS participants
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
  'Returns active waitlist entries with participants. Safe for anon access.';

-- ============================================================================
-- FUNCTION: get_upcoming_blocks
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
    AND b.starts_at > request_time
    AND b.starts_at <= end_of_today
  ORDER BY b.starts_at ASC, c.court_number ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION get_upcoming_blocks(TIMESTAMPTZ) SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_upcoming_blocks TO anon;
GRANT EXECUTE ON FUNCTION get_upcoming_blocks TO service_role;

COMMENT ON FUNCTION get_upcoming_blocks IS
  'Returns upcoming blocks for today (started after now, before midnight).';

-- ============================================================================
-- FUNCTION: cleanup_old_signals
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

-- ============================================================================
-- FUNCTION: move_court_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION move_court_atomic(
  p_from_court_id UUID,
  p_to_court_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session_record RECORD;
  v_blocking_session RECORD;
  v_blocking_block RECORD;
BEGIN
  -- Lock and get the active session on source court
  SELECT id, court_id, started_at, scheduled_end_at, session_type
  INTO v_session_record
  FROM sessions
  WHERE court_id = p_from_court_id
    AND actual_end_at IS NULL
  FOR UPDATE;

  IF v_session_record IS NULL THEN
    RETURN json_build_object(
      'ok', false,
      'code', 'NO_ACTIVE_SESSION',
      'message', 'No active session found on source court'
    );
  END IF;

  -- Check for active session on destination (with lock)
  SELECT id INTO v_blocking_session
  FROM sessions
  WHERE court_id = p_to_court_id
    AND actual_end_at IS NULL
  FOR UPDATE;

  IF v_blocking_session.id IS NOT NULL THEN
    RETURN json_build_object(
      'ok', false,
      'code', 'DESTINATION_OCCUPIED',
      'message', 'Destination court already has an active session'
    );
  END IF;

  -- Check for ACTIVE blocks on destination
  SELECT id INTO v_blocking_block
  FROM blocks
  WHERE court_id = p_to_court_id
    AND starts_at <= NOW()
    AND ends_at >= NOW()
    AND (cancelled_at IS NULL);

  IF v_blocking_block.id IS NOT NULL THEN
    RETURN json_build_object(
      'ok', false,
      'code', 'DESTINATION_BLOCKED',
      'message', 'Destination court is currently blocked'
    );
  END IF;

  -- Perform the atomic move
  UPDATE sessions
  SET court_id = p_to_court_id
  WHERE id = v_session_record.id;

  RETURN json_build_object(
    'ok', true,
    'sessionId', v_session_record.id,
    'fromCourtId', p_from_court_id,
    'toCourtId', p_to_court_id
  );
END;
$$;

-- ============================================================================
-- FUNCTION: end_session_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION end_session_atomic(
  p_session_id UUID,
  p_end_reason TEXT,
  p_device_id UUID,
  p_server_now TIMESTAMPTZ,
  p_event_data JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session RECORD;
  v_end_reason TEXT;
  v_merged_event_data JSONB;
BEGIN
  -- Validate end_reason
  v_end_reason := COALESCE(p_end_reason, 'cleared');
  IF v_end_reason NOT IN ('cleared', 'observed_cleared', 'admin_override', 'overtime_takeover', 'auto_cleared') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid end_reason: ' || v_end_reason
    );
  END IF;

  -- Get session and check if already ended (with row lock to prevent races)
  SELECT id, actual_end_at, court_id
  INTO v_session
  FROM sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Session not found: ' || p_session_id
    );
  END IF;

  IF v_session.actual_end_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'already_ended', true
    );
  END IF;

  -- Merge event data with standard fields
  v_merged_event_data := jsonb_build_object(
    'reason', v_end_reason,
    'device_id', p_device_id::text
  ) || COALESCE(p_event_data, '{}'::JSONB);

  -- Step 1: Insert END event (source of truth)
  INSERT INTO session_events (
    session_id,
    event_type,
    event_data,
    created_at,
    created_by
  ) VALUES (
    p_session_id,
    'END',
    v_merged_event_data,
    p_server_now,
    p_device_id::text
  );

  -- Step 2: Update sessions cache (same transaction - atomic)
  UPDATE sessions
  SET
    actual_end_at = p_server_now,
    end_reason = v_end_reason
  WHERE id = p_session_id;

  -- Both succeeded - return success
  RETURN jsonb_build_object(
    'success', true,
    'already_ended', false,
    'court_id', v_session.court_id
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Any error rolls back both operations
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

-- ============================================================================
-- FUNCTION: reorder_waitlist
-- ============================================================================
CREATE OR REPLACE FUNCTION reorder_waitlist(
  p_entry_id UUID,
  p_new_position INTEGER,
  p_device_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry RECORD;
  v_old_position INTEGER;
  v_max_position INTEGER;
BEGIN
  -- Get the entry and its current position
  SELECT id, position INTO v_entry
  FROM waitlist
  WHERE id = p_entry_id AND status = 'waiting'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Waitlist entry not found or not in waiting status'
    );
  END IF;

  v_old_position := v_entry.position;

  -- Validate new position
  SELECT MAX(position) INTO v_max_position
  FROM waitlist
  WHERE status = 'waiting';

  IF p_new_position < 1 OR p_new_position > v_max_position THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid position: must be between 1 and ' || v_max_position
    );
  END IF;

  -- No change needed
  IF v_old_position = p_new_position THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Position unchanged'
    );
  END IF;

  -- Shift other entries
  IF p_new_position < v_old_position THEN
    -- Moving up: shift entries between new and old position down
    UPDATE waitlist
    SET position = position + 1
    WHERE status = 'waiting'
      AND position >= p_new_position
      AND position < v_old_position;
  ELSE
    -- Moving down: shift entries between old and new position up
    UPDATE waitlist
    SET position = position - 1
    WHERE status = 'waiting'
      AND position > v_old_position
      AND position <= p_new_position;
  END IF;

  -- Set the entry to its new position
  UPDATE waitlist
  SET position = p_new_position
  WHERE id = p_entry_id;

  RETURN jsonb_build_object(
    'success', true,
    'old_position', v_old_position,
    'new_position', p_new_position
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

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
