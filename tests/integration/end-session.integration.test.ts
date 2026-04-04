import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000000010';
const TEST_MEMBER_ID = 'd0000000-0000-0000-0000-000000000011';

const TEST_SESSION_IDS = {
  s1: 'd0000000-0000-0000-0000-000000000001',
  s2: 'd0000000-0000-0000-0000-000000000002',
};

describe.skipIf(MISSING_ENV)('end-session Edge Function (integration)', () => {
  let adminClient: any;
  let court1Id: string;
  let court2Id: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courts, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .in('court_number', [1, 2]);

    if (courtsError || !courts || courts.length < 2) {
      throw new Error(`Failed to fetch test courts: ${courtsError?.message ?? 'not enough courts'}`);
    }

    court1Id = courts.find((c: any) => c.court_number === 1)!.id;
    court2Id = courts.find((c: any) => c.court_number === 2)!.id;

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-9999',
      account_name: 'Integration Test Account',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    const ids = Object.values(TEST_SESSION_IDS);
    await adminClient.from('session_events').delete().in('session_id', ids);
    await adminClient.from('session_participants').delete().in('session_id', ids);
    await adminClient.from('sessions').delete().in('id', ids);
  });

  afterAll(async () => {
    await adminClient.from('members').delete().eq('id', TEST_MEMBER_ID);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
  });

  async function insertTestSession(sessionId: string, courtId: string): Promise<void> {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const scheduledEndAt = new Date(now.getTime() + 50 * 60 * 1000).toISOString();

    const { error: sessionError } = await adminClient.from('sessions').insert({
      id: sessionId,
      court_id: courtId,
      session_type: 'singles',
      duration_minutes: 60,
      started_at: startedAt,
      scheduled_end_at: scheduledEndAt,
      actual_end_at: null,
      created_by_device_id: KIOSK_DEVICE_ID,
      registered_by_member_id: TEST_MEMBER_ID,
      participant_key: `m:${TEST_MEMBER_ID}`,
    });

    if (sessionError) {
      throw new Error(`Failed to insert test session ${sessionId}: ${sessionError.message}`);
    }

    const { error: participantError } = await adminClient.from('session_participants').insert({
      session_id: sessionId,
      member_id: TEST_MEMBER_ID,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID,
    });

    if (participantError) {
      throw new Error(`Failed to insert test participant for ${sessionId}: ${participantError.message}`);
    }
  }

  async function callEndSession(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/end-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('ends an active session by session_id and returns 200 with session details', async () => {
    await insertTestSession(TEST_SESSION_IDS.s1, court1Id);

    const res = await callEndSession({
      session_id: TEST_SESSION_IDS.s1,
      end_reason: 'cleared',
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body.session).toBeDefined();
    expect(body.session.id).toBe(TEST_SESSION_IDS.s1);
    expect(body.session.courtId).toBe(court1Id);
    expect(body.board).toBeDefined();
  });

  it('ends an active session by court number and returns 200 with sessionsEnded: 1', async () => {
    await insertTestSession(TEST_SESSION_IDS.s1, court2Id);

    const res = await callEndSession({
      court_id: 2,
      end_reason: 'observed_cleared',
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.sessionsEnded).toBe(1);
    expect(body.board).toBeDefined();
  });

  it('returns 400 MISSING_IDENTIFIER when neither session_id nor court_id is provided', async () => {
    const res = await callEndSession({ end_reason: 'cleared' });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('MISSING_IDENTIFIER');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns 400 INVALID_END_REASON for an unrecognized end_reason value', async () => {
    const res = await callEndSession({
      session_id: TEST_SESSION_IDS.s1,
      end_reason: 'not_a_real_reason',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INVALID_END_REASON');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns 409 SESSION_ALREADY_ENDED when ending an already-ended session by session_id', async () => {
    await insertTestSession(TEST_SESSION_IDS.s1, court1Id);

    // First call — should succeed
    const first = await callEndSession({
      session_id: TEST_SESSION_IDS.s1,
      end_reason: 'cleared',
      device_id: KIOSK_DEVICE_ID,
    });
    expect(first.status).toBe(200);

    // Second call — should conflict
    const res = await callEndSession({
      session_id: TEST_SESSION_IDS.s1,
      end_reason: 'cleared',
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('SESSION_ALREADY_ENDED');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });
});
