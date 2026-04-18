import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000000030';
const TEST_MEMBER_IDS = {
  m1: 'd0000000-0000-0000-0000-000000000031',
  m2: 'd0000000-0000-0000-0000-000000000032',
  m3: 'd0000000-0000-0000-0000-000000000033',
  m4: 'd0000000-0000-0000-0000-000000000034',
};

// Deterministic IDs for pre-inserted test fixtures
const PRE_INSERTED_SESSION_ID = 'd0000000-0000-0000-0000-000000003002';
const PRE_INSERTED_BLOCK_ID = 'd0000000-0000-0000-0000-000000003001';

describe.skipIf(MISSING_ENV)('assign-court Edge Function (integration)', () => {
  let adminClient: any;
  let courts: Array<{ id: string; court_number: number }> = [];

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courtsData, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .order('court_number', { ascending: true });

    if (courtsError || !courtsData || courtsData.length < 2) {
      throw new Error(`Failed to fetch courts: ${courtsError?.message ?? 'fewer than 2 courts found'}`);
    }

    courts = courtsData;

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-ASSIGN-001',
      account_name: 'Integration Test Account (Assign)',
      status: 'active',
    });

    for (const [key, id] of Object.entries(TEST_MEMBER_IDS)) {
      await adminClient.from('members').upsert({
        id,
        account_id: TEST_ACCOUNT_ID,
        display_name: `Integration Test Member (${key})`,
        is_primary: key === 'm1',
        status: 'active',
      });
    }
  });

  afterEach(async () => {
    const memberIds = Object.values(TEST_MEMBER_IDS);

    // Find sessions created by the function (registered_by_member_id in our test members)
    const { data: dynamicSessions } = await adminClient
      .from('sessions')
      .select('id')
      .in('registered_by_member_id', memberIds);

    const dynamicSessionIds = (dynamicSessions ?? []).map((s: any) => s.id);
    const allSessionIds = [...new Set([...dynamicSessionIds, PRE_INSERTED_SESSION_ID])];

    // Delete in FK order
    await adminClient.from('transactions').delete().in('session_id', allSessionIds);
    await adminClient.from('session_events').delete().in('session_id', allSessionIds);
    await adminClient.from('session_participants').delete().in('session_id', allSessionIds);
    await adminClient.from('sessions').delete().in('id', allSessionIds);

    // Delete pre-inserted block
    await adminClient.from('blocks').delete().eq('id', PRE_INSERTED_BLOCK_ID);
  });

  afterAll(async () => {
    const memberIds = Object.values(TEST_MEMBER_IDS);
    await adminClient.from('members').delete().in('id', memberIds);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
  });

  async function callAssignCourt(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/assign-court`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  // NOTE: Tests 1 and 2 (happy paths) and tests 3 and 4 (occupied/blocked) require
  // the club to be within operating hours (America/Chicago). They will return
  // ok: false with a non-internal_error code if run outside business hours.

  it('assigns a singles session and returns ok: true with session details', async () => {
    const courtId = courts[0].id;

    const res = await callAssignCourt({
      court_id: courtId,
      session_type: 'singles',
      participants: [{ type: 'member', member_id: TEST_MEMBER_IDS.m1, account_id: TEST_ACCOUNT_ID }],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body.session).toBeDefined();
    expect(body.session.court_id).toBe(courtId);
    expect(body.session.session_type).toBe('singles');
    expect(typeof body.session.id).toBe('string');
    expect(typeof body.session.started_at).toBe('string');
    expect(typeof body.session.scheduled_end_at).toBe('string');
    expect(body.session.participants).toHaveLength(1);
    expect(body.board).toBeDefined();
    expect(body.displacement).toBeNull();

    // Verify DB state
    const { data: dbSession } = await adminClient
      .from('sessions')
      .select('session_type, actual_end_at')
      .eq('id', body.session.id)
      .single();

    expect(dbSession).toBeDefined();
    expect(dbSession.session_type).toBe('singles');
    expect(dbSession.actual_end_at).toBeNull();
  });

  it('assigns a doubles session and creates 2 session_participants rows', async () => {
    const courtId = courts[1].id;

    const res = await callAssignCourt({
      court_id: courtId,
      session_type: 'doubles',
      participants: [
        { type: 'member', member_id: TEST_MEMBER_IDS.m3, account_id: TEST_ACCOUNT_ID },
        { type: 'member', member_id: TEST_MEMBER_IDS.m4, account_id: TEST_ACCOUNT_ID },
      ],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.session.session_type).toBe('doubles');
    expect(body.session.participants).toHaveLength(2);

    // Verify 2 session_participants rows in DB
    const { data: participants } = await adminClient
      .from('session_participants')
      .select('member_id')
      .eq('session_id', body.session.id);

    expect(participants).toHaveLength(2);
  });

  it('returns ok: false with code COURT_OCCUPIED when court has an active session', async () => {
    const courtId = courts[0].id;
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const scheduledEndAt = new Date(now.getTime() + 50 * 60 * 1000).toISOString();

    // Pre-insert an active session on the court
    const { error: sessionError } = await adminClient.from('sessions').insert({
      id: PRE_INSERTED_SESSION_ID,
      court_id: courtId,
      session_type: 'singles',
      duration_minutes: 60,
      started_at: startedAt,
      scheduled_end_at: scheduledEndAt,
      actual_end_at: null,
      created_by_device_id: KIOSK_DEVICE_ID,
      registered_by_member_id: TEST_MEMBER_IDS.m1,
      participant_key: `m:${TEST_MEMBER_IDS.m1}`,
    });

    if (sessionError) {
      throw new Error(`Failed to insert pre-existing session: ${sessionError.message}`);
    }

    await adminClient.from('session_participants').insert({
      session_id: PRE_INSERTED_SESSION_ID,
      member_id: TEST_MEMBER_IDS.m1,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID,
    });

    const res = await callAssignCourt({
      court_id: courtId,
      session_type: 'singles',
      participants: [{ type: 'member', member_id: TEST_MEMBER_IDS.m2, account_id: TEST_ACCOUNT_ID }],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('COURT_OCCUPIED');
    expect(body.message).toContain('occupied');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code COURT_BLOCKED when court has an active block', async () => {
    const courtId = courts[0].id;
    const now = new Date();
    const startsAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const endsAt = new Date(now.getTime() + 50 * 60 * 1000).toISOString();

    // Pre-insert an active block on the court
    const { error: blockError } = await adminClient.from('blocks').insert({
      id: PRE_INSERTED_BLOCK_ID,
      court_id: courtId,
      block_type: 'clinic',
      title: 'Integration Test Block',
      starts_at: startsAt,
      ends_at: endsAt,
      is_recurring: false,
      created_by_device_id: KIOSK_DEVICE_ID,
      cancelled_at: null,
    });

    if (blockError) {
      throw new Error(`Failed to insert pre-existing block: ${blockError.message}`);
    }

    const res = await callAssignCourt({
      court_id: courtId,
      session_type: 'singles',
      participants: [{ type: 'member', member_id: TEST_MEMBER_IDS.m2, account_id: TEST_ACCOUNT_ID }],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('COURT_BLOCKED');
    expect(body.message).toContain('blocked');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code COURT_NOT_FOUND for a non-existent court_id', async () => {
    const res = await callAssignCourt({
      court_id: '00000000-0000-0000-0000-000000000000',
      session_type: 'singles',
      participants: [{ type: 'member', member_id: TEST_MEMBER_IDS.m1, account_id: TEST_ACCOUNT_ID }],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('COURT_NOT_FOUND');
    expect(body.message).toContain('Court not found');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code INTERNAL_ERROR when participants is empty', async () => {
    const courtId = courts[0].id;

    const res = await callAssignCourt({
      court_id: courtId,
      session_type: 'singles',
      participants: [],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toContain('At least one participant is required');
    expect(typeof body.serverNow).toBe('string');
  });
});
