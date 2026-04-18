-- Make insert_ball_purchase_split idempotent at the DB layer.
--
-- The edge function pre-checks for existing transactions before calling this
-- RPC, but that check uses the plain idempotency key and misses the
-- ${base}-split-N keys stored here. A retry that slips past the pre-check
-- would get a unique_violation and surface as a generic error.
--
-- This revision catches unique_violation and returns the already-inserted
-- rows, so the RPC is safe to call twice with the same base key.

CREATE OR REPLACE FUNCTION insert_ball_purchase_split(
  p_account_ids TEXT[],
  p_session_id UUID,
  p_amount_cents INTEGER,
  p_description TEXT,
  p_device_id UUID,
  p_idempotency_base TEXT
)
RETURNS JSONB
AS $$
DECLARE
  v_tx RECORD;
  v_results JSONB := '[]'::JSONB;
  v_idx INTEGER := 0;
  v_key TEXT;
BEGIN
  FOREACH v_key IN ARRAY p_account_ids LOOP
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
  WHEN unique_violation THEN
    -- A retry reached the RPC despite the edge function pre-check.
    -- Return the already-inserted rows so the caller gets a clean result.
    SELECT jsonb_build_object(
      'success', true,
      'transactions', jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'account_id', t.account_id,
          'amount_cents', t.amount_cents,
          'description', t.description
        )
      )
    )
    INTO v_results
    FROM transactions t
    WHERE t.idempotency_key LIKE p_idempotency_base || '-split-%';

    RETURN v_results;

  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION insert_ball_purchase_split(TEXT[], UUID, INTEGER, TEXT, UUID, TEXT) SET search_path = public, pg_temp;

COMMENT ON FUNCTION insert_ball_purchase_split IS
  'Atomically inserts split ball purchase transactions. Idempotent: unique_violation on retry returns existing rows instead of erroring.';
