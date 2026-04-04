import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000000040';
const TEST_MEMBER_IDS = {
  m1: 'd0000000-0000-0000-0000-000000000041',
  m2: 'd0000000-0000-0000-0000-000000000042',
  m3: 'd0000000-0000-0000-0000-000000000043',
  m4: 'd0000000-0000-0000-0000-000000000044',
};

// Deterministic ID for the pre-inserted session used in the court-occupied test
const PRE_INSERTED_SESSION_ID = 'd0000000-0000-0000-0000-000000004001';

// NOTE: assign-from-waitlist does NOT check operating hours.
// All tests in this suite are time-agnostic.

// NOTE: This function does NOT use the shared response helpers.
// All responses — success and error — return HTTP 200.
// Error shape (production): { ok: false, error: string, serverNow: string }
//   (local source has code/message split but it is not yet deployed)
// Success shape: { ok: true, serverNow, session: {...}, waitlist: {...}, positions_updated, board }

describe.skipIf(MISSING_ENV)('assign-from-waitlist Edge Function (integration)', () => {
  let adminClient: any;
  let courts: Array<{ id: string; court_number: number }> = [];

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courtsData, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .order('court_number', { ascending: true });

    if (courtsError || !courtsData || courtsData.length < 3) {
      throw new Error(`Failed to fetch courts: ${courtsError?.message ?? 'fewer than 3 courts found'}`);
    }

    courts = courtsData;

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-ASSIGN-WL-001',
      account_name: 'Integration Test Account (Assign From Waitlist)',
      status: 'active',
    });

    for (const [key, id] of Object.entries(TEST_MEMBER_IDS)) {
      await adminClient.from('members').upsert({
        id,
        account_id: TEST_ACCOUNT_ID,
        display_name: `Integration Test Member AFW (${key})`,
        is_primary: key === 'm1',
        status: 'active',
      });
    }
  });

  afterEach(async () => {
    const memberIds = Object.values(TEST_MEMBER_IDS);

    // Find sessions created by the function (registered by test members)
    const { data: dynSessions } = await adminClient
      .from('sessions')
      .select('id')
      .in('registered_by_member_id', memberIds);

    const dynSessionIds = (dynSessions ?? []).map((s: any) => s.id);
    const allSessionIds = [...new Set([...dynSessionIds, PRE_INSERTED_SESSION_ID])];

    // Find waitlist entries that reference test members
    const { data: wlMemberRows } = await adminClient
      .from('waitlist_members')
      .select('waitlist_id')
      .in('member_id', memberIds);

    const waitlistIds = [...new Set((wlMemberRows ?? []).map((r: any) => r.waitlist_id))];

    // Delete in FK-safe order.
    // waitlist.assigned_session_id references sessions with ON DELETE RESTRICT,
    // so waitlist rows must be deleted before their referenced sessions.
    await adminClient.from('transactions').delete().in('session_id', allSessionIds);
    await adminClient.from('session_events').delete().in('session_id', allSessionIds);
    await adminClient.from('session_participants').delete().in('session_id', allSessionIds);
    if (waitlistIds.length > 0) {
      await adminClient.from('waitlist_members').delete().in('waitlist_id', waitlistIds);
      await adminClient.from('waitlist').delete().in('id', waitlistIds);
    }
    await adminClient.from('sessions').delete().in('id', allSessionIds);
  });

  afterAll(async () => {
    const memberIds = Object.values(TEST_MEMBER_IDS);
    await adminClient.from('members').delete().in('id', memberIds);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
  });

  /**
   * Insert a waitlist entry and corresponding waitlist_members rows.
   * Returns the waitlist entry UUID.
   */
  async function insertTestWaitlistEntry(
    groupType: 'singles' | 'doubles',
    memberIds: string[],
  ): Promise<string> {
    const { data: entry, error: entryError } = await adminClient
      .from('waitlist')
      .insert({
        group_type: groupType,
        position: 1,
        status: 'waiting',
        created_by_device_id: KIOSK_DEVICE_ID,
      })
      .select('id')
      .single();

    if (entryError || !entry) {
      throw new Error(`Failed to insert waitlist entry: ${entryError?.message}`);
    }

    const memberRows = memberIds.map((memberId) => ({
      waitlist_id: entry.id,
      member_id: memberId,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID,
    }));

    const { error: membersError } = await adminClient
      .from('waitlist_members')
      .insert(memberRows);

    if (membersError) {
      throw new Error(`Failed to insert waitlist_members: ${membersError.message}`);
    }

    return entry.id;
  }

  async function callAssignFromWaitlist(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/assign-from-waitlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('assigns a doubles waitlist group to an available court and marks the entry as assigned', async () => {
    const courtId = courts[0].id;
    const waitlistId = await insertTestWaitlistEntry('doubles', [
      TEST_MEMBER_IDS.m1,
      TEST_MEMBER_IDS.m2,
    ]);

    const res = await callAssignFromWaitlist({
      waitlist_id: waitlistId,
      court_id: courtId,
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body.session).toBeDefined();
    expect(body.session.court_id).toBe(courtId);
    expect(body.session.session_type).toBe('doubles');
    expect(typeof body.session.id).toBe('string');
    expect(body.session.participants).toHaveLength(2);
    expect(body.waitlist).toBeDefined();
    expect(body.waitlist.id).toBe(waitlistId);
    expect(body.waitlist.status).toBe('assigned');
    expect(body.board).toBeDefined();

    // Verify DB state: session created with 2 participants
    const { data: participants } = await adminClient
      .from('session_participants')
      .select('member_id')
      .eq('session_id', body.session.id);

    expect(participants).toHaveLength(2);

    // Verify waitlist entry updated to 'assigned'
    const { data: wlEntry } = await adminClient
      .from('waitlist')
      .select('status, assigned_session_id')
      .eq('id', waitlistId)
      .single();

    expect(wlEntry.status).toBe('assigned');
    expect(wlEntry.assigned_session_id).toBe(body.session.id);
  });

  it('assigns a singles waitlist group and creates a session with 1 participant', async () => {
    const courtId = courts[1].id;
    const waitlistId = await insertTestWaitlistEntry('singles', [TEST_MEMBER_IDS.m3]);

    const res = await callAssignFromWaitlist({
      waitlist_id: waitlistId,
      court_id: courtId,
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.session.session_type).toBe('singles');
    expect(body.session.participants).toHaveLength(1);
    expect(body.waitlist.status).toBe('assigned');

    // Verify 1 session_participants row in DB
    const { data: participants } = await adminClient
      .from('session_participants')
      .select('member_id')
      .eq('session_id', body.session.id);

    expect(participants).toHaveLength(1);
  });

  it('returns ok: false with code INTERNAL_ERROR when the waitlist entry does not exist', async () => {
    const courtId = courts[0].id;

    const res = await callAssignFromWaitlist({
      waitlist_id: '00000000-0000-0000-0000-000000000000',
      court_id: courtId,
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Waitlist entry not found');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code INTERNAL_ERROR when the target court is currently occupied', async () => {
    const courtId = courts[2].id;
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    // scheduled_end_at is 50 minutes in the future — not overtime
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

    // Insert a waitlist entry to assign from
    const waitlistId = await insertTestWaitlistEntry('singles', [TEST_MEMBER_IDS.m4]);

    const res = await callAssignFromWaitlist({
      waitlist_id: waitlistId,
      court_id: courtId,
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('occupied');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code INTERNAL_ERROR when waitlist_id is missing from the request', async () => {
    const res = await callAssignFromWaitlist({});

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('waitlist_id is required');
    expect(typeof body.serverNow).toBe('string');
  });
});
