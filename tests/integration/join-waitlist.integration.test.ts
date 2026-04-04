import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000000020';
const TEST_MEMBER_IDS = {
  m1: 'd0000000-0000-0000-0000-000000000021',
  m2: 'd0000000-0000-0000-0000-000000000022',
  m3: 'd0000000-0000-0000-0000-000000000023',
  m4: 'd0000000-0000-0000-0000-000000000024',
};

// Session IDs for filling 12 courts — d0000000-*-2xxx range avoids conflicts with end-session tests
const FILL_SESSION_IDS = Array.from({ length: 12 }, (_, i) =>
  `d0000000-0000-0000-0000-${String(2001 + i).padStart(12, '0')}`
);

describe.skipIf(MISSING_ENV)('join-waitlist Edge Function (integration)', () => {
  let adminClient: any;
  let courts: Array<{ id: string; court_number: number }> = [];

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courtsData, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .order('court_number', { ascending: true });

    if (courtsError || !courtsData || courtsData.length < 12) {
      throw new Error(`Failed to fetch courts: ${courtsError?.message ?? 'fewer than 12 courts found'}`);
    }

    courts = courtsData;

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-WAITLIST-001',
      account_name: 'Integration Test Account (Waitlist)',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_IDS.m1,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (m1)',
      is_primary: true,
      status: 'active',
    });
    await adminClient.from('members').upsert({
      id: TEST_MEMBER_IDS.m2,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (m2)',
      is_primary: false,
      status: 'active',
    });
    await adminClient.from('members').upsert({
      id: TEST_MEMBER_IDS.m3,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (m3)',
      is_primary: false,
      status: 'active',
    });
    await adminClient.from('members').upsert({
      id: TEST_MEMBER_IDS.m4,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (m4)',
      is_primary: false,
      status: 'active',
    });
  });

  afterEach(async () => {
    // Find waitlist entries associated with test members before deleting
    const memberIds = Object.values(TEST_MEMBER_IDS);
    const { data: wlMembers } = await adminClient
      .from('waitlist_members')
      .select('waitlist_id')
      .in('member_id', memberIds);

    const waitlistIds = (wlMembers ?? []).map((r: any) => r.waitlist_id);

    // Delete waitlist data in FK order
    await adminClient.from('waitlist_members').delete().in('member_id', memberIds);
    if (waitlistIds.length > 0) {
      await adminClient.from('waitlist').delete().in('id', waitlistIds);
    }

    // Delete fill-court session data in FK order
    await adminClient.from('session_events').delete().in('session_id', FILL_SESSION_IDS);
    await adminClient.from('session_participants').delete().in('session_id', FILL_SESSION_IDS);
    await adminClient.from('sessions').delete().in('id', FILL_SESSION_IDS);
  });

  afterAll(async () => {
    const memberIds = Object.values(TEST_MEMBER_IDS);
    await adminClient.from('members').delete().in('id', memberIds);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
  });

  async function fillAllCourts(): Promise<void> {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const scheduledEndAt = new Date(now.getTime() + 50 * 60 * 1000).toISOString();

    for (let i = 0; i < 12; i++) {
      const sessionId = FILL_SESSION_IDS[i];
      const courtId = courts[i].id;

      const { error: sessionError } = await adminClient.from('sessions').insert({
        id: sessionId,
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
        throw new Error(`Failed to fill court ${courts[i].court_number}: ${sessionError.message}`);
      }

      const { error: participantError } = await adminClient.from('session_participants').insert({
        session_id: sessionId,
        member_id: TEST_MEMBER_IDS.m1,
        participant_type: 'member',
        account_id: TEST_ACCOUNT_ID,
      });

      if (participantError) {
        throw new Error(`Failed to insert participant for fill session ${sessionId}: ${participantError.message}`);
      }
    }
  }

  async function callJoinWaitlist(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/join-waitlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  // NOTE: Tests 1 and 2 require the club to be within operating hours (America/Chicago).
  // They will return ok: false with code OUTSIDE_HOURS or CLUB_CLOSED if run after hours.

  it('joins waitlist for a singles group and returns ok: true with a waiting entry', async () => {
    await fillAllCourts();

    const res = await callJoinWaitlist({
      group_type: 'singles',
      participants: [{ type: 'member', member_id: TEST_MEMBER_IDS.m1, account_id: TEST_ACCOUNT_ID }],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body.data).toBeDefined();
    expect(body.data.waitlist).toBeDefined();
    expect(body.data.waitlist.group_type).toBe('singles');
    expect(body.data.waitlist.status).toBe('waiting');
    expect(typeof body.data.waitlist.position).toBe('number');

    // Verify DB state
    const waitlistId = body.data.waitlist.id;
    const { data: entry } = await adminClient
      .from('waitlist')
      .select('status, group_type')
      .eq('id', waitlistId)
      .single();

    expect(entry).toBeDefined();
    expect(entry.status).toBe('waiting');
    expect(entry.group_type).toBe('singles');
  });

  it('joins waitlist for a doubles group and creates 2 waitlist_members rows', async () => {
    await fillAllCourts();

    const res = await callJoinWaitlist({
      group_type: 'doubles',
      participants: [
        { type: 'member', member_id: TEST_MEMBER_IDS.m1, account_id: TEST_ACCOUNT_ID },
        { type: 'member', member_id: TEST_MEMBER_IDS.m2, account_id: TEST_ACCOUNT_ID },
      ],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.waitlist.group_type).toBe('doubles');

    // Verify 2 waitlist_members rows in DB
    const waitlistId = body.data.waitlist.id;
    const { data: members } = await adminClient
      .from('waitlist_members')
      .select('member_id')
      .eq('waitlist_id', waitlistId);

    expect(members).toHaveLength(2);
  });

  it('returns ok: false with code INVALID_GROUP_TYPE for an unrecognized group_type', async () => {
    // join-waitlist uses HTTP 200 for all denials (business-rule failures)
    const res = await callJoinWaitlist({
      group_type: 'invalid',
      participants: [],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INVALID_GROUP_TYPE');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code NO_PARTICIPANTS when participants field is missing', async () => {
    const res = await callJoinWaitlist({
      group_type: 'singles',
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NO_PARTICIPANTS');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  it('returns ok: false with code NO_PARTICIPANTS when participants array is empty', async () => {
    const res = await callJoinWaitlist({
      group_type: 'singles',
      participants: [],
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NO_PARTICIPANTS');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });
});
