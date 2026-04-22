import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeActiveTestSessionsOnCourts, purgeBlocksByIds, purgeSessionsForMembers, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

// UUID namespace: d0000000-0000-0000-0000-000000007xxx
// move-court accepts admin OR kiosk — use the pre-seeded kiosk device
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000007010';
const TEST_MEMBER_ID = 'd0000000-0000-0000-0000-000000007011';

const TEST_SESSION_IDS = {
  s1: 'd0000000-0000-0000-0000-000000007001',
  s2: 'd0000000-0000-0000-0000-000000007002',
};
const TEST_BLOCK_ID = 'd0000000-0000-0000-0000-000000007020';

describe.skipIf(MISSING_ENV)('move-court Edge Function (integration)', () => {
  let adminClient: any;
  let court1Id: string;
  let court2Id: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courts, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .eq('is_active', true)
      .order('court_number', { ascending: true })
      .limit(2);

    if (courtsError || !courts || courts.length < 2) {
      throw new Error(`Failed to fetch 2 test courts: ${courtsError?.message ?? 'fewer than 2 active courts'}`);
    }

    court1Id = courts[0].id;
    court2Id = courts[1].id;

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-MOVE-001',
      account_name: 'Integration Test Account (move-court)',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (move-court)',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    await safeCleanup('move-court', async () => {
      await purgeSessionsForMembers(adminClient, [TEST_MEMBER_ID], Object.values(TEST_SESSION_IDS));
      await purgeBlocksByIds(adminClient, [TEST_BLOCK_ID]);
      await purgeActiveTestSessionsOnCourts(adminClient, [court1Id, court2Id]);
    });
  });

  afterAll(async () => {
    await adminClient.from('members').delete().eq('id', TEST_MEMBER_ID);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
  });

  async function insertSession(sessionId: string, courtId: string): Promise<void> {
    const now = new Date();
    const { error } = await adminClient.from('sessions').insert({
      id: sessionId,
      court_id: courtId,
      session_type: 'singles',
      duration_minutes: 60,
      started_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      scheduled_end_at: new Date(now.getTime() + 50 * 60 * 1000).toISOString(),
      actual_end_at: null,
      created_by_device_id: KIOSK_DEVICE_ID,
      registered_by_member_id: TEST_MEMBER_ID,
      participant_key: `m:${TEST_MEMBER_ID}`,
    });
    if (error) throw new Error(`Failed to insert session ${sessionId}: ${error.message}`);
  }

  async function insertActiveBlock(blockId: string, courtId: string): Promise<void> {
    // Block that is currently active: started 5 minutes ago, ends in 55 minutes
    const now = new Date();
    const { error } = await adminClient.from('blocks').insert({
      id: blockId,
      court_id: courtId,
      block_type: 'maintenance',
      title: 'Integration Test Active Block (move-court)',
      starts_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      ends_at: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
      is_recurring: false,
      created_by_device_id: KIOSK_DEVICE_ID,
    });
    if (error) throw new Error(`Failed to insert block ${blockId}: ${error.message}`);
  }

  async function callMoveCourt(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/move-court`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('moves an active session from court A to court B and returns 200 with session and board', async () => {
    await insertSession(TEST_SESSION_IDS.s1, court1Id);

    const res = await callMoveCourt({
      from_court_id: court1Id,
      to_court_id: court2Id,
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body.sessionId).toBe(TEST_SESSION_IDS.s1);
    expect(body.fromCourtId).toBe(court1Id);
    expect(body.toCourtId).toBe(court2Id);
    expect(body.board).toBeDefined();
    expect(Array.isArray(body.board.courts)).toBe(true);

    // Verify the session was actually moved in the DB
    const { data: session } = await adminClient
      .from('sessions')
      .select('court_id')
      .eq('id', TEST_SESSION_IDS.s1)
      .single();

    expect(session.court_id).toBe(court2Id);
  });

  it('returns 404 not_found when source court has no active session', async () => {
    // No session inserted — court1 is empty

    const res = await callMoveCourt({
      from_court_id: court1Id,
      to_court_id: court2Id,
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('not_found');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns 409 DESTINATION_OCCUPIED when destination court already has an active session', async () => {
    await insertSession(TEST_SESSION_IDS.s1, court1Id);
    await insertSession(TEST_SESSION_IDS.s2, court2Id);

    const res = await callMoveCourt({
      from_court_id: court1Id,
      to_court_id: court2Id,
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('DESTINATION_OCCUPIED');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns 409 DESTINATION_BLOCKED when destination court has an active block', async () => {
    await insertSession(TEST_SESSION_IDS.s1, court1Id);
    await insertActiveBlock(TEST_BLOCK_ID, court2Id);

    const res = await callMoveCourt({
      from_court_id: court1Id,
      to_court_id: court2Id,
      device_id: KIOSK_DEVICE_ID,
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('DESTINATION_BLOCKED');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns 400 BAD_REQUEST when device_id is missing', async () => {
    const res = await callMoveCourt({
      from_court_id: court1Id,
      to_court_id: court2Id,
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('BAD_REQUEST');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });
});
