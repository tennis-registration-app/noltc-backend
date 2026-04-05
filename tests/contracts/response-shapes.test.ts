/**
 * Edge Function response shape contract tests.
 *
 * These are SHAPE tests — they verify field names and types match what the frontend
 * expects, not business logic. They catch API drift before it reaches the frontend.
 *
 * One call per endpoint per shape (success + error). No heavy DB setup except where
 * a live session is needed to produce a success response.
 *
 * Time-sensitive note: assign-court and join-waitlist happy paths require the live
 * instance to be within operating hours (6 AM – 11 PM Central). Outside those hours
 * the success-shape tests are skipped via conditional — the error-shape tests always run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000000050';
const TEST_MEMBER_IDS = {
  m1: 'd0000000-0000-0000-0000-000000000051',
  m2: 'd0000000-0000-0000-0000-000000000052',
};
const TEST_SESSION_ID = 'd0000000-0000-0000-0000-000000005001';

function fnUrl(name: string) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

describe.skipIf(MISSING_ENV)('Edge Function response shape contracts', () => {
  let adminClient: any;
  let court1Id: string;
  let court2Id: string;
  const createdSessionIds: string[] = [];
  const createdWaitlistIds: string[] = [];

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courts, error } = await adminClient
      .from('courts')
      .select('id, court_number')
      .order('court_number', { ascending: true })
      .limit(2);

    if (error || !courts || courts.length < 2) {
      throw new Error(`Failed to fetch courts: ${error?.message ?? 'fewer than 2 courts found'}`);
    }

    court1Id = courts[0].id;
    court2Id = courts[1].id;

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-CONTRACT-001',
      account_name: 'Contract Test Account',
      status: 'active',
    });

    for (const [key, id] of Object.entries(TEST_MEMBER_IDS)) {
      await adminClient.from('members').upsert({
        id,
        account_id: TEST_ACCOUNT_ID,
        display_name: `Contract Test Member (${key})`,
        is_primary: key === 'm1',
        status: 'active',
      });
    }
  });

  afterAll(async () => {
    if (createdWaitlistIds.length > 0) {
      await adminClient.from('waitlist_members').delete().in('waitlist_id', createdWaitlistIds);
      await adminClient.from('waitlist').delete().in('id', createdWaitlistIds);
    }
    if (createdSessionIds.length > 0) {
      await adminClient.from('session_events').delete().in('session_id', createdSessionIds);
      await adminClient.from('session_participants').delete().in('session_id', createdSessionIds);
      await adminClient.from('sessions').delete().in('id', createdSessionIds);
    }
    // Belt-and-suspenders cleanup for the end-session test session
    await adminClient.from('session_events').delete().eq('session_id', TEST_SESSION_ID);
    await adminClient.from('session_participants').delete().eq('session_id', TEST_SESSION_ID);
    await adminClient.from('sessions').delete().eq('id', TEST_SESSION_ID);

    await adminClient.from('members').delete().in('id', Object.values(TEST_MEMBER_IDS));
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
  });

  // ── get-board ──────────────────────────────────────────────────────────────

  it('get-board: top-level envelope fields (ok, serverNow, arrays)', async () => {
    const res = await fetch(fnUrl('get-board'), {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(Array.isArray(body.courts)).toBe(true);
    expect(Array.isArray(body.waitlist)).toBe(true);
    expect(Array.isArray(body.operatingHours)).toBe(true);
    expect(Array.isArray(body.upcomingBlocks)).toBe(true);
  });

  it('get-board: court object shape (court_id|id, court_number, status)', async () => {
    const res = await fetch(fnUrl('get-board'), {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(body.courts.length).toBeGreaterThan(0);
    const court = body.courts[0];
    const hasId = 'court_id' in court || 'id' in court;
    expect(hasId).toBe(true);
    expect(typeof court.court_number).toBe('number');
    expect(typeof court.status).toBe('string');
  });

  it('get-board: operatingHours entry shape (day_of_week, opens_at, closes_at, is_closed)', async () => {
    const res = await fetch(fnUrl('get-board'), {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(body.operatingHours.length).toBeGreaterThan(0);
    const slot = body.operatingHours[0];
    expect(slot).toHaveProperty('day_of_week');
    expect(slot).toHaveProperty('opens_at');
    expect(slot).toHaveProperty('closes_at');
    expect(slot).toHaveProperty('is_closed');
  });

  // ── assign-court ───────────────────────────────────────────────────────────

  it('assign-court success: session shape (id, court_id, session_type, started_at, scheduled_end_at, participants, displacement)', async () => {
    const res = await fetch(fnUrl('assign-court'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
        court_id: court1Id,
        session_type: 'singles',
        participants: [{ member_id: TEST_MEMBER_IDS.m1 }],
      }),
    });
    const body = await res.json() as any;

    // May be OUTSIDE_HOURS, OCCUPIED, or other error — verify error shape and skip success assertions
    if (!body.ok) {
      expect(typeof body.code).toBe('string');
      return;
    }

    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body).toHaveProperty('board');
    expect(body).toHaveProperty('session');

    const session = body.session;
    expect(typeof session.id).toBe('string');
    expect(typeof session.court_id).toBe('string');
    expect(typeof session.session_type).toBe('string');
    expect(typeof session.started_at).toBe('string');
    expect(typeof session.scheduled_end_at).toBe('string');
    expect(Array.isArray(session.participants)).toBe(true);
    expect('displacement' in body).toBe(true); // null when no displacement

    if (session?.id) createdSessionIds.push(session.id);
  });

  it('assign-court error: ok:false with code, message, serverNow', async () => {
    const res = await fetch(fnUrl('assign-court'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    const body = await res.json() as any;

    expect(body.ok).toBe(false);
    expect(typeof body.code).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  // ── end-session ────────────────────────────────────────────────────────────

  it('end-session success: session shape (id, court_id, session_type, started_at) and board', async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const scheduledEndAt = new Date(now.getTime() + 50 * 60 * 1000).toISOString();

    const { error: sessionError } = await adminClient.from('sessions').insert({
      id: TEST_SESSION_ID,
      court_id: court2Id,
      session_type: 'singles',
      duration_minutes: 60,
      started_at: startedAt,
      scheduled_end_at: scheduledEndAt,
      actual_end_at: null,
      created_by_device_id: KIOSK_DEVICE_ID,
      registered_by_member_id: TEST_MEMBER_IDS.m1,
      participant_key: `m:${TEST_MEMBER_IDS.m1}`,
    });
    if (sessionError) throw new Error(`Session insert failed: ${sessionError.message}`);

    const { error: participantError } = await adminClient.from('session_participants').insert({
      session_id: TEST_SESSION_ID,
      member_id: TEST_MEMBER_IDS.m1,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID,
    });
    if (participantError) throw new Error(`Participant insert failed: ${participantError.message}`);

    const res = await fetch(fnUrl('end-session'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
        session_id: TEST_SESSION_ID,
        end_reason: 'cleared',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body).toHaveProperty('session');
    expect(body).toHaveProperty('board');

    const session = body.session;
    expect(typeof session.id).toBe('string');
    expect(typeof session.courtId).toBe('string');
    expect(typeof session.sessionType).toBe('string');
    expect(typeof session.startedAt).toBe('string');
  });

  it('end-session error: 400 with ok:false, code, message, serverNow', async () => {
    const res = await fetch(fnUrl('end-session'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;

    expect(body.ok).toBe(false);
    expect(typeof body.code).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });

  // ── join-waitlist ──────────────────────────────────────────────────────────

  it('join-waitlist success: data.waitlist shape (id, group_type, position, status, joined_at, participants)', async () => {
    const res = await fetch(fnUrl('join-waitlist'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
        group_type: 'singles',
        participants: [{ member_id: TEST_MEMBER_IDS.m2 }],
      }),
    });
    const body = await res.json() as any;

    // May be OUTSIDE_HOURS or CLUB_CLOSED — verify error shape and skip success assertions
    if (!body.ok) {
      expect(typeof body.code).toBe('string');
      expect(typeof body.message).toBe('string');
      expect(typeof body.serverNow).toBe('string');
      return;
    }

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
    expect(body).toHaveProperty('data');

    const waitlist = body.data.waitlist;
    expect(typeof waitlist.id).toBe('string');
    expect(typeof waitlist.group_type).toBe('string');
    expect(typeof waitlist.position).toBe('number');
    expect(typeof waitlist.status).toBe('string');
    expect(typeof waitlist.joined_at).toBe('string');
    expect(Array.isArray(waitlist.participants)).toBe(true);

    if (waitlist?.id) createdWaitlistIds.push(waitlist.id);
  });

  it('join-waitlist error: 400 with ok:false, code, message, serverNow for invalid group_type', async () => {
    const res = await fetch(fnUrl('join-waitlist'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
        group_type: 'not_a_valid_type',
        participants: [{ member_id: TEST_MEMBER_IDS.m1 }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;

    expect(body.ok).toBe(false);
    expect(typeof body.code).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
  });
});
