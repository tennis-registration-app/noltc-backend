-- Fix: Use correct table name 'blocks' instead of 'court_blocks'
-- Also ensure we only check active blocks (current time window)

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

  -- Check for ACTIVE blocks on destination (correct table: 'blocks')
  SELECT id INTO v_blocking_block
  FROM blocks
  WHERE court_id = p_to_court_id
    AND starts_at <= NOW()
    AND ends_at >= NOW()
    AND (cancelled_at IS NULL);  -- Only non-cancelled blocks

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
