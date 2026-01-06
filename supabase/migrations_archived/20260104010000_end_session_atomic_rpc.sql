-- Atomic end session RPC function
-- Wraps END event insert + sessions cache update in a single transaction
-- Ensures cache consistency and proper "already ended" detection

CREATE OR REPLACE FUNCTION end_session_atomic(
  p_session_id UUID,
  p_end_reason TEXT,
  p_device_id UUID,
  p_server_now TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session RECORD;
  v_end_reason TEXT;
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
    jsonb_build_object('reason', v_end_reason, 'device_id', p_device_id::text),
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
