-- Atomic waitlist creation
--
-- join-waitlist previously had two correctness problems:
--
--   1. Non-atomic insert: the waitlist row was inserted first, then
--      waitlist_members in a second call. If the second call failed the
--      waitlist entry was orphaned (visible on the board with zero players).
--
--   2. Position race: next position was computed by reading MAX(position)
--      then inserting. Two concurrent requests could both read the same max
--      and insert duplicate position values — no unique constraint prevents it.
--
-- This RPC fixes both by running position assignment and both inserts inside
-- one transaction, serialized by a transaction-scoped advisory lock so
-- concurrent waitlist creates can't race on position.

CREATE OR REPLACE FUNCTION create_waitlist_entry(
  p_group_type TEXT,
  p_joined_at TIMESTAMPTZ,
  p_created_by_device_id UUID,
  p_deferred BOOLEAN,
  p_participants JSONB
)
RETURNS JSONB
AS $$
DECLARE
  v_waitlist_id UUID;
  v_position INTEGER;
  v_participant JSONB;
BEGIN
  -- Serialize concurrent position assignments. The lock is released when
  -- the transaction commits or rolls back.
  PERFORM pg_advisory_xact_lock(hashtext('waitlist_position_lock'));

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_position
  FROM waitlist
  WHERE status = 'waiting';

  INSERT INTO waitlist (
    group_type,
    position,
    status,
    joined_at,
    created_by_device_id,
    deferred
  ) VALUES (
    p_group_type,
    v_position,
    'waiting',
    p_joined_at,
    p_created_by_device_id,
    p_deferred
  )
  RETURNING id INTO v_waitlist_id;

  FOR v_participant IN SELECT * FROM jsonb_array_elements(p_participants) LOOP
    INSERT INTO waitlist_members (
      waitlist_id,
      member_id,
      guest_name,
      participant_type,
      account_id
    ) VALUES (
      v_waitlist_id,
      NULLIF(v_participant->>'member_id', '')::UUID,
      NULLIF(v_participant->>'guest_name', ''),
      v_participant->>'participant_type',
      (v_participant->>'account_id')::UUID
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'waitlist_id', v_waitlist_id,
    'position', v_position
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION create_waitlist_entry(TEXT, TIMESTAMPTZ, UUID, BOOLEAN, JSONB) SET search_path = public, pg_temp;

COMMENT ON FUNCTION create_waitlist_entry IS
  'Atomically creates a waitlist entry and its members. Uses an advisory lock to serialize position assignment across concurrent requests. Returns {success, waitlist_id, position} or {success:false, error}.';
