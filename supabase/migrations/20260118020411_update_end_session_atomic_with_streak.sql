-- Update end_session_atomic to handle uncleared session streak tracking
-- When end_reason = 'cleared': reset registrant's streak to 0
-- When end_reason is anything else: increment registrant's streak by 1

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
  v_registrant_id UUID;
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
  SELECT id, actual_end_at, court_id, registered_by_member_id
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

  -- Step 3: Update uncleared session streak for registrant
  v_registrant_id := v_session.registered_by_member_id;

  IF v_registrant_id IS NOT NULL THEN
    IF v_end_reason = 'cleared' THEN
      -- Player properly cleared their court - reset streak to 0
      UPDATE members
      SET uncleared_streak = 0
      WHERE id = v_registrant_id;
    ELSE
      -- Session ended without player clearing - increment streak
      UPDATE members
      SET uncleared_streak = uncleared_streak + 1
      WHERE id = v_registrant_id;
    END IF;
  END IF;

  -- All succeeded - return success
  RETURN jsonb_build_object(
    'success', true,
    'already_ended', false,
    'court_id', v_session.court_id
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Any error rolls back all operations
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION end_session_atomic IS
  'Atomically ends a session: inserts END event, updates session cache, and updates registrant uncleared streak';
