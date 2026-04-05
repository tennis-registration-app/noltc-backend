-- Migration: create_session_with_fees atomic RPC
-- Wraps session creation, participant insertion, transaction creation
-- (guest fees, ball purchase), and optional waitlist update in a single
-- DB transaction.
-- Called by assign-court and assign-from-waitlist Edge Functions.
--
-- v2: adds p_waitlist_id / p_waitlist_position optional parameters so
--     assign-from-waitlist can atomically mark the entry as assigned and
--     compact the position sequence in the same transaction.

CREATE OR REPLACE FUNCTION create_session_with_fees(
  p_session_id              UUID,
  p_court_id                UUID,
  p_session_type            TEXT,
  p_duration_minutes        INTEGER,
  p_started_at              TIMESTAMPTZ,
  p_scheduled_end_at        TIMESTAMPTZ,
  p_device_id               UUID,
  p_participant_key         TEXT,
  p_registered_by_member_id UUID,
  -- Participants JSONB array. Each element:
  -- { "member_id": uuid|null, "guest_name": text|null,
  --   "participant_type": "member"|"guest", "account_id": uuid,
  --   "charged_to_account_id": uuid|null }
  p_participants            JSONB,
  -- Guest fee rate already resolved to weekday/weekend by caller.
  -- Pass 0 or NULL to skip guest fee insertion even if guests are present.
  p_guest_fee_cents         INTEGER,
  p_add_balls               BOOLEAN,
  -- Full can price resolved by caller from system_settings.
  -- Ignored when p_add_balls is false.
  p_ball_price_cents        INTEGER,
  p_split_balls             BOOLEAN,
  -- Optional: assign-from-waitlist path only.
  -- If provided, marks the waitlist entry as assigned and compacts positions.
  -- assign-court passes NULL for both (DEFAULT NULL = no-op).
  p_waitlist_id             UUID    DEFAULT NULL,
  p_waitlist_position       INTEGER DEFAULT NULL
)
RETURNS JSONB
AS $$
DECLARE
  v_session_id          UUID := p_session_id;
  v_transaction_ids     UUID[] := '{}';
  v_tx_id               UUID;
  v_participant         JSONB;
  v_member_participants JSONB;
  v_member_count        INTEGER;
  v_split_amount        INTEGER;
  v_charge_account      UUID;
BEGIN

  -- =========================================================
  -- 1. INSERT SESSION
  -- =========================================================
  INSERT INTO sessions (
    id,
    court_id,
    session_type,
    duration_minutes,
    started_at,
    scheduled_end_at,
    created_by_device_id,
    participant_key,
    registered_by_member_id
  ) VALUES (
    v_session_id,
    p_court_id,
    p_session_type,
    p_duration_minutes,
    p_started_at,
    p_scheduled_end_at,
    p_device_id,
    p_participant_key,
    p_registered_by_member_id
  );

  -- =========================================================
  -- 2. INSERT SESSION_PARTICIPANTS (batch)
  -- =========================================================
  INSERT INTO session_participants (
    session_id,
    member_id,
    guest_name,
    participant_type,
    account_id
  )
  SELECT
    v_session_id,
    (p->>'member_id')::UUID,
    p->>'guest_name',
    p->>'participant_type',
    (p->>'account_id')::UUID
  FROM jsonb_array_elements(p_participants) AS p;

  -- =========================================================
  -- 3. INSERT GUEST FEE TRANSACTIONS
  --    One row per guest. charged_to_account_id overrides account_id
  --    for cases where a member sponsors their guest's fee.
  -- =========================================================
  IF p_guest_fee_cents IS NOT NULL AND p_guest_fee_cents > 0 THEN
    FOR v_participant IN
      SELECT value
      FROM jsonb_array_elements(p_participants)
      WHERE value->>'participant_type' = 'guest'
    LOOP
      v_charge_account := COALESCE(
        (v_participant->>'charged_to_account_id')::UUID,
        (v_participant->>'account_id')::UUID
      );

      INSERT INTO transactions (
        account_id,
        transaction_type,
        amount_cents,
        description,
        session_id,
        created_by_device_id
      ) VALUES (
        v_charge_account,
        'guest_fee',
        p_guest_fee_cents,
        'Guest fee for ' || (v_participant->>'guest_name'),
        v_session_id,
        p_device_id
      )
      RETURNING id INTO v_tx_id;

      v_transaction_ids := array_append(v_transaction_ids, v_tx_id);
    END LOOP;
  END IF;

  -- =========================================================
  -- 4. INSERT BALL PURCHASE TRANSACTION(S)
  --    Split path: ceil(price / member_count) per member.
  --    Single-payer path: full price charged to participants[0].
  -- =========================================================
  IF p_add_balls THEN

    SELECT jsonb_agg(value)
    INTO v_member_participants
    FROM jsonb_array_elements(p_participants)
    WHERE value->>'participant_type' = 'member';

    v_member_count := COALESCE(jsonb_array_length(v_member_participants), 0);

    IF p_split_balls AND v_member_count > 1 THEN

      v_split_amount := CEIL(p_ball_price_cents::NUMERIC / v_member_count);

      FOR v_participant IN
        SELECT value FROM jsonb_array_elements(v_member_participants)
      LOOP
        INSERT INTO transactions (
          account_id,
          transaction_type,
          amount_cents,
          description,
          session_id,
          created_by_device_id
        ) VALUES (
          (v_participant->>'account_id')::UUID,
          'ball_purchase',
          v_split_amount,
          'Tennis balls (split ' || v_member_count || ' ways)',
          v_session_id,
          p_device_id
        )
        RETURNING id INTO v_tx_id;

        v_transaction_ids := array_append(v_transaction_ids, v_tx_id);
      END LOOP;

    ELSE

      -- Single payer: first element of p_participants (member or guest)
      INSERT INTO transactions (
        account_id,
        transaction_type,
        amount_cents,
        description,
        session_id,
        created_by_device_id
      ) VALUES (
        (p_participants->0->>'account_id')::UUID,
        'ball_purchase',
        p_ball_price_cents,
        'Tennis balls',
        v_session_id,
        p_device_id
      )
      RETURNING id INTO v_tx_id;

      v_transaction_ids := array_append(v_transaction_ids, v_tx_id);

    END IF;
  END IF;

  -- =========================================================
  -- 5. UPDATE WAITLIST ENTRY (assign-from-waitlist path only)
  --    Skipped entirely when p_waitlist_id IS NULL (assign-court path).
  -- =========================================================
  IF p_waitlist_id IS NOT NULL THEN

    UPDATE waitlist
    SET
      status              = 'assigned',
      assigned_at         = NOW(),
      assigned_session_id = v_session_id
    WHERE id = p_waitlist_id;

    -- Compact positions: single UPDATE replaces the N-round-trip loop
    -- that the Edge Function previously used.
    IF p_waitlist_position IS NOT NULL THEN
      UPDATE waitlist
      SET position = position - 1
      WHERE status   = 'waiting'
        AND position > p_waitlist_position;
    END IF;

  END IF;

  -- =========================================================
  -- 6. RETURN session_id and all inserted transaction IDs.
  --    Any unhandled exception propagates, rolling back the
  --    entire transaction automatically.
  -- =========================================================
  RETURN jsonb_build_object(
    'session_id',      v_session_id,
    'transaction_ids', to_jsonb(v_transaction_ids)
  );

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION create_session_with_fees(
  UUID, UUID, TEXT, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, UUID,
  JSONB, INTEGER, BOOLEAN, INTEGER, BOOLEAN,
  UUID, INTEGER
) SET search_path = public, pg_temp;
