-- Atomic waitlist reorder RPC function
-- Moves a waitlist entry from one position to another, shifting others accordingly

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
