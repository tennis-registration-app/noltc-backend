-- Atomic split ball purchase: inserts all split transactions in a single
-- database transaction so either all charges succeed or none do.
-- Fixes: same-account idempotency key collision when two family members
-- share an account (old key was ${base}-${accountId}, now ${base}-split-${index}).

CREATE OR REPLACE FUNCTION insert_ball_purchase_split(
  p_account_ids TEXT[],          -- one entry per player (may contain duplicates)
  p_session_id UUID,
  p_amount_cents INTEGER,        -- per-player share (already ceiled by caller)
  p_description TEXT,
  p_device_id UUID,
  p_idempotency_base TEXT        -- nullable; base key from client
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tx RECORD;
  v_results JSONB := '[]'::JSONB;
  v_idx INTEGER := 0;
  v_key TEXT;
BEGIN
  FOREACH v_key IN ARRAY p_account_ids LOOP
    -- Build per-player idempotency key using array index to avoid collisions
    DECLARE
      v_idemp TEXT := NULL;
    BEGIN
      IF p_idempotency_base IS NOT NULL THEN
        v_idemp := p_idempotency_base || '-split-' || v_idx;
      END IF;

      INSERT INTO transactions (
        account_id,
        session_id,
        transaction_type,
        amount_cents,
        description,
        created_by_device_id,
        idempotency_key
      ) VALUES (
        v_key::UUID,
        p_session_id,
        'ball_purchase',
        p_amount_cents,
        p_description,
        p_device_id,
        v_idemp
      )
      RETURNING id, account_id, amount_cents, description
      INTO v_tx;

      v_results := v_results || jsonb_build_object(
        'id', v_tx.id,
        'account_id', v_tx.account_id,
        'amount_cents', v_tx.amount_cents,
        'description', v_tx.description
      );
    END;

    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'transactions', v_results
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Any error rolls back ALL inserts in this function call
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION insert_ball_purchase_split IS
  'Atomically inserts split ball purchase transactions. Uses array index in idempotency key to allow duplicate account IDs (family members on same account).';
