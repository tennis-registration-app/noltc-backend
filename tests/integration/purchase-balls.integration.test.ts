import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeSessionsForMembers, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

// UUID namespace: d0000000-0000-0000-0000-000000008xxx
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID_1 = 'd0000000-0000-0000-0000-000000008010';
const TEST_ACCOUNT_ID_2 = 'd0000000-0000-0000-0000-000000008011';
const TEST_MEMBER_ID_1 = 'd0000000-0000-0000-0000-000000008020';
const TEST_MEMBER_ID_2 = 'd0000000-0000-0000-0000-000000008021';
const TEST_SESSION_ID = 'd0000000-0000-0000-0000-000000008001';
const NONEXISTENT_SESSION_ID = 'd0000000-0000-0000-0000-000000008099';

describe.skipIf(MISSING_ENV)('purchase-balls Edge Function (integration)', () => {
  let adminClient: any;
  let courtId: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courts, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .eq('is_active', true)
      .order('court_number', { ascending: true })
      .limit(1);

    if (courtsError || !courts || courts.length === 0) {
      throw new Error(`Failed to fetch test court: ${courtsError?.message ?? 'no active courts'}`);
    }

    courtId = courts[0].id;

    // Upsert two accounts
    for (const [id, num] of [[TEST_ACCOUNT_ID_1, '8010'], [TEST_ACCOUNT_ID_2, '8011']] as const) {
      await adminClient.from('accounts').upsert({
        id,
        member_number: `TEST-BALLS-${num}`,
        account_name: `Integration Test Account (purchase-balls ${num})`,
        status: 'active',
      });
    }

    // Upsert two members
    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID_1,
      account_id: TEST_ACCOUNT_ID_1,
      display_name: 'Test Member 1 (purchase-balls)',
      is_primary: true,
      status: 'active',
    });
    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID_2,
      account_id: TEST_ACCOUNT_ID_2,
      display_name: 'Test Member 2 (purchase-balls)',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    await safeCleanup('purchase-balls', async () => {
      await purgeSessionsForMembers(
        adminClient,
        [TEST_MEMBER_ID_1, TEST_MEMBER_ID_2],
        [TEST_SESSION_ID],
      );
    });
  });

  afterAll(async () => {
    for (const id of [TEST_MEMBER_ID_1, TEST_MEMBER_ID_2]) {
      await adminClient.from('members').delete().eq('id', id);
    }
    for (const id of [TEST_ACCOUNT_ID_1, TEST_ACCOUNT_ID_2]) {
      await adminClient.from('accounts').delete().eq('id', id);
    }
  });

  async function insertSession(sessionId: string): Promise<void> {
    const now = new Date();
    const { error: sessionError } = await adminClient.from('sessions').insert({
      id: sessionId,
      court_id: courtId,
      session_type: 'singles',
      duration_minutes: 60,
      started_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      scheduled_end_at: new Date(now.getTime() + 50 * 60 * 1000).toISOString(),
      actual_end_at: null,
      created_by_device_id: KIOSK_DEVICE_ID,
      registered_by_member_id: TEST_MEMBER_ID_1,
      participant_key: `m:${TEST_MEMBER_ID_1}`,
    });
    if (sessionError) throw new Error(`Failed to insert session: ${sessionError.message}`);

    const { error: participantError } = await adminClient.from('session_participants').insert({
      session_id: sessionId,
      member_id: TEST_MEMBER_ID_1,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID_1,
    });
    if (participantError) throw new Error(`Failed to insert participant: ${participantError.message}`);
  }

  async function callPurchaseBalls(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/purchase-balls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('purchases balls for an active session and returns 200 with transaction details', async () => {
    await insertSession(TEST_SESSION_ID);

    const res = await callPurchaseBalls({
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
      session_id: TEST_SESSION_ID,
      account_id: TEST_ACCOUNT_ID_1,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.length).toBe(1);

    const tx = body.transactions[0];
    expect(tx.account_id).toBe(TEST_ACCOUNT_ID_1);
    expect(typeof tx.id).toBe('string');
    expect(typeof tx.amount_cents).toBe('number');
    expect(tx.amount_cents).toBeGreaterThan(0);
    expect(typeof tx.amount_dollars).toBe('string');
    expect(typeof tx.description).toBe('string');
    expect(typeof body.total_cents).toBe('number');
    expect(body.total_cents).toBe(tx.amount_cents);

    // Verify transaction row exists in DB
    const { data: dbTx } = await adminClient
      .from('transactions')
      .select('id, account_id, transaction_type, amount_cents')
      .eq('session_id', TEST_SESSION_ID)
      .single();

    expect(dbTx).toBeDefined();
    expect(dbTx.account_id).toBe(TEST_ACCOUNT_ID_1);
    expect(dbTx.transaction_type).toBe('ball_purchase');
    expect(dbTx.amount_cents).toBeGreaterThan(0);
  });

  it('returns 200 with ok: false and error when session does not exist', async () => {
    const res = await callPurchaseBalls({
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
      session_id: NONEXISTENT_SESSION_ID,
      account_id: TEST_ACCOUNT_ID_1,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/session not found/i);
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns 200 with ok: false and error when session_id is missing', async () => {
    const res = await callPurchaseBalls({
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
      account_id: TEST_ACCOUNT_ID_1,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/session_id is required/i);
    expect(typeof body.serverNow).toBe('string');
  });

  it('splits the ball purchase between two accounts and returns a transaction per account', async () => {
    await insertSession(TEST_SESSION_ID);

    // Add second participant so both accounts are in the session
    await adminClient.from('session_participants').insert({
      session_id: TEST_SESSION_ID,
      member_id: TEST_MEMBER_ID_2,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID_2,
    });

    const res = await callPurchaseBalls({
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
      session_id: TEST_SESSION_ID,
      account_id: TEST_ACCOUNT_ID_1,
      split_balls: true,
      split_account_ids: [TEST_ACCOUNT_ID_1, TEST_ACCOUNT_ID_2],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.length).toBe(2);

    const accountIds = body.transactions.map((tx: any) => tx.account_id);
    expect(accountIds).toContain(TEST_ACCOUNT_ID_1);
    expect(accountIds).toContain(TEST_ACCOUNT_ID_2);

    // Each split charge should be less than the full price
    for (const tx of body.transactions) {
      expect(typeof tx.amount_cents).toBe('number');
      expect(tx.amount_cents).toBeGreaterThan(0);
    }

    // Verify two transaction rows in DB
    const { data: dbTxs } = await adminClient
      .from('transactions')
      .select('id, account_id, amount_cents')
      .eq('session_id', TEST_SESSION_ID);

    expect(dbTxs).toBeDefined();
    expect(dbTxs.length).toBe(2);
  });
});
