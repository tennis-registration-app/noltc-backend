/**
 * Integration tests for admin session operations:
 * - admin-end-session
 * - admin-update-session
 * - restore-session
 * - undo-overtime-takeover
 * - update-session-tournament
 *
 * UUID namespace: d0000000-0000-0000-0000-000000011xxx
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeActiveTestSessionsOnCourts, purgeSessionsForMembers, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DEVICE_ID  = 'd0000000-0000-0000-0000-000000011001';
const KIOSK_DEVICE_ID  = 'a0000000-0000-0000-0000-000000000001'; // pre-seeded
const TEST_ACCOUNT_ID  = 'd0000000-0000-0000-0000-000000011010';
const TEST_MEMBER_ID   = 'd0000000-0000-0000-0000-000000011011';

// Session ID slots — one per test concern so afterEach can wipe them all cleanly
const SESSION_FOR_END      = 'd0000000-0000-0000-0000-000000011020';
const SESSION_FOR_UPDATE   = 'd0000000-0000-0000-0000-000000011021';
const DISPLACED_SESSION    = 'd0000000-0000-0000-0000-000000011022';
const TAKEOVER_SESSION     = 'd0000000-0000-0000-0000-000000011023';
const DISPLACED_FOR_UNDO   = 'd0000000-0000-0000-0000-000000011024';
const TOURNAMENT_SESSION   = 'd0000000-0000-0000-0000-000000011025';
// Fake takeover reference used in restore-session context (need not exist in DB)
const FAKE_TAKEOVER_REF    = 'd0000000-0000-0000-0000-000000011099';

const ALL_SESSION_IDS = [
  SESSION_FOR_END,
  SESSION_FOR_UPDATE,
  DISPLACED_SESSION,
  TAKEOVER_SESSION,
  DISPLACED_FOR_UNDO,
  TOURNAMENT_SESSION,
];

describe.skipIf(MISSING_ENV)('admin session ops Edge Functions (integration)', () => {
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
      throw new Error(`Need at least 2 active courts: ${courtsError?.message ?? 'not enough'}`);
    }
    court1Id = courts[0].id;
    court2Id = courts[1].id;

    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (admin-session-ops)',
      device_token: 'test-admin-token-session-ops',
      is_active: true,
    });

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-SESSOPS-001',
      account_name: 'Integration Test Account (admin-session-ops)',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (admin-session-ops)',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    await safeCleanup('admin-session-ops', async () => {
      await purgeSessionsForMembers(adminClient, [TEST_MEMBER_ID], ALL_SESSION_IDS);
      await purgeActiveTestSessionsOnCourts(adminClient, [court1Id, court2Id]);
    });
  });

  afterAll(async () => {
    await adminClient.from('members').delete().eq('id', TEST_MEMBER_ID);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function insertActiveSession(sessionId: string, courtId: string): Promise<void> {
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
      participant_key: `m:${TEST_MEMBER_ID}:${sessionId}`,
    });
    if (error) throw new Error(`Failed to insert active session ${sessionId}: ${error.message}`);
  }

  async function insertEndedSession(sessionId: string, courtId: string): Promise<void> {
    const now = new Date();
    const { error } = await adminClient.from('sessions').insert({
      id: sessionId,
      court_id: courtId,
      session_type: 'singles',
      duration_minutes: 60,
      started_at: new Date(now.getTime() - 90 * 60 * 1000).toISOString(),
      scheduled_end_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      actual_end_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      end_reason: 'overtime_takeover',
      created_by_device_id: KIOSK_DEVICE_ID,
      registered_by_member_id: TEST_MEMBER_ID,
      participant_key: `m:${TEST_MEMBER_ID}:${sessionId}`,
    });
    if (error) throw new Error(`Failed to insert ended session ${sessionId}: ${error.message}`);
  }

  async function insertEndEvent(
    sessionId: string,
    eventData: Record<string, unknown>
  ): Promise<void> {
    const { error } = await adminClient.from('session_events').insert({
      session_id: sessionId,
      event_type: 'END',
      event_data: eventData,
      created_by: KIOSK_DEVICE_ID,
    });
    if (error) throw new Error(`Failed to insert END event for ${sessionId}: ${error.message}`);
  }

  async function callFunction(name: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  // ─── admin-end-session ────────────────────────────────────────────────────

  describe('admin-end-session', () => {
    it('ends an active session by session_id, returns 200 with ok:true and board', async () => {
      await insertActiveSession(SESSION_FOR_END, court1Id);

      const res = await callFunction('admin-end-session', {
        device_id: ADMIN_DEVICE_ID,
        session_id: SESSION_FOR_END,
        reason: 'integration_test',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.session.id).toBe(SESSION_FOR_END);
      expect(body.session.courtId).toBe(court1Id);
      expect(typeof body.session.endedAt).toBe('string');
      expect(typeof body.serverNow).toBe('string');
      expect(body.board).toBeDefined();
      expect(Array.isArray(body.board.courts)).toBe(true);

      // Verify DB
      const { data: s } = await adminClient
        .from('sessions')
        .select('actual_end_at')
        .eq('id', SESSION_FOR_END)
        .single();
      expect(s.actual_end_at).not.toBeNull();
    });

    it('ends a session by court_id and returns 200 with ok:true', async () => {
      await insertActiveSession(SESSION_FOR_END, court1Id);

      const res = await callFunction('admin-end-session', {
        device_id: ADMIN_DEVICE_ID,
        court_id: court1Id,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.serverNow).toBe('string');
    });

    it('returns 200 ok:true code:NO_ACTIVE_SESSION when court has no active session', async () => {
      const res = await callFunction('admin-end-session', {
        device_id: ADMIN_DEVICE_ID,
        court_id: court2Id,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.code).toBe('NO_ACTIVE_SESSION');
    });

    it('returns HTTP 409 SESSION_ALREADY_ENDED for a session that is already ended', async () => {
      await insertEndedSession(SESSION_FOR_END, court1Id);

      const res = await callFunction('admin-end-session', {
        device_id: ADMIN_DEVICE_ID,
        session_id: SESSION_FOR_END,
      });

      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('SESSION_ALREADY_ENDED');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls admin-end-session', async () => {
      const res = await callFunction('admin-end-session', {
        device_id: KIOSK_DEVICE_ID,
        session_id: SESSION_FOR_END,
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns HTTP 400 MISSING_DEVICE when device_id is absent', async () => {
      const res = await callFunction('admin-end-session', {
        session_id: SESSION_FOR_END,
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('MISSING_DEVICE');
    });

    it('returns HTTP 400 MISSING_IDENTIFIER when neither session_id nor court_id is given', async () => {
      const res = await callFunction('admin-end-session', {
        device_id: ADMIN_DEVICE_ID,
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('MISSING_IDENTIFIER');
    });
  });

  // ─── admin-update-session ─────────────────────────────────────────────────

  describe('admin-update-session', () => {
    it('updates participants on an active session, returns 200 with ok:true and participants array', async () => {
      await insertActiveSession(SESSION_FOR_UPDATE, court1Id);
      await adminClient.from('session_participants').insert({
        session_id: SESSION_FOR_UPDATE,
        member_id: TEST_MEMBER_ID,
        participant_type: 'member',
        account_id: TEST_ACCOUNT_ID,
      });

      const futureEndAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();

      const res = await callFunction('admin-update-session', {
        device_id: ADMIN_DEVICE_ID,
        session_id: SESSION_FOR_UPDATE,
        participants: [
          {
            name: 'Integration Test Member (admin-session-ops)',
            type: 'member',
            member_id: TEST_MEMBER_ID,
          },
        ],
        scheduled_end_at: futureEndAt,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.session.id).toBe(SESSION_FOR_UPDATE);
      expect(Array.isArray(body.session.participants)).toBe(true);
      expect(typeof body.session.scheduledEndAt).toBe('string');
      expect(typeof body.serverNow).toBe('string');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls admin-update-session', async () => {
      const res = await callFunction('admin-update-session', {
        device_id: KIOSK_DEVICE_ID,
        session_id: SESSION_FOR_UPDATE,
        participants: [],
        scheduled_end_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns HTTP 400 MISSING_SESSION when session_id is absent', async () => {
      const res = await callFunction('admin-update-session', {
        device_id: ADMIN_DEVICE_ID,
        participants: [],
        scheduled_end_at: null,
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('MISSING_SESSION');
    });

    it('returns HTTP 404 SESSION_NOT_FOUND for a non-existent session', async () => {
      const res = await callFunction('admin-update-session', {
        device_id: ADMIN_DEVICE_ID,
        session_id: 'd0000000-0000-0000-0000-000000011090',
        participants: [],
        scheduled_end_at: null,
      });

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns HTTP 400 SESSION_ENDED when trying to update a session that has ended', async () => {
      await insertEndedSession(SESSION_FOR_UPDATE, court1Id);

      const res = await callFunction('admin-update-session', {
        device_id: ADMIN_DEVICE_ID,
        session_id: SESSION_FOR_UPDATE,
        participants: [],
        scheduled_end_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('SESSION_ENDED');
    });
  });

  // ─── restore-session ──────────────────────────────────────────────────────
  //
  // Requires a session that was ended by overtime_takeover:
  //   1. session.actual_end_at IS NOT NULL
  //   2. session_events END row with event_data.trigger = 'overtime_takeover'
  //   3. No active session on the displaced session's court

  describe('restore-session', () => {
    it('restores a displaced session, returns 200 with ok:true and restoredSessionId', async () => {
      await insertEndedSession(DISPLACED_SESSION, court2Id);
      await insertEndEvent(DISPLACED_SESSION, {
        trigger: 'overtime_takeover',
        takeover_session_id: FAKE_TAKEOVER_REF,
      });

      const res = await callFunction('restore-session', {
        device_id: KIOSK_DEVICE_ID,
        displaced_session_id: DISPLACED_SESSION,
        takeover_session_id: FAKE_TAKEOVER_REF,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.restoredSessionId).toBe(DISPLACED_SESSION);
      expect(typeof body.serverNow).toBe('string');

      // Verify in DB: actual_end_at cleared (session is active again)
      const { data: s } = await adminClient
        .from('sessions')
        .select('actual_end_at')
        .eq('id', DISPLACED_SESSION)
        .single();
      expect(s.actual_end_at).toBeNull();
    });

    it('returns 200 ok:false RESTORE_CONFLICT when session was not ended by overtime_takeover', async () => {
      await insertEndedSession(DISPLACED_SESSION, court2Id);
      await insertEndEvent(DISPLACED_SESSION, { trigger: 'admin_override' }); // wrong trigger

      const res = await callFunction('restore-session', {
        device_id: KIOSK_DEVICE_ID,
        displaced_session_id: DISPLACED_SESSION,
        takeover_session_id: FAKE_TAKEOVER_REF,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('RESTORE_CONFLICT');
      expect(body.message).toMatch(/was not ended by overtime takeover/i);
    });

    it('returns 200 ok:false RESTORE_CONFLICT when the displaced session is still active', async () => {
      await insertActiveSession(DISPLACED_SESSION, court2Id); // not ended — still active

      const res = await callFunction('restore-session', {
        device_id: KIOSK_DEVICE_ID,
        displaced_session_id: DISPLACED_SESSION,
        takeover_session_id: FAKE_TAKEOVER_REF,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('RESTORE_CONFLICT');
    });

    it('returns 200 ok:false RESTORE_CONFLICT when court is occupied by another session', async () => {
      await insertEndedSession(DISPLACED_SESSION, court2Id);
      await insertEndEvent(DISPLACED_SESSION, {
        trigger: 'overtime_takeover',
        takeover_session_id: FAKE_TAKEOVER_REF,
      });
      await insertActiveSession(TAKEOVER_SESSION, court2Id); // occupies the court

      const res = await callFunction('restore-session', {
        device_id: KIOSK_DEVICE_ID,
        displaced_session_id: DISPLACED_SESSION,
        takeover_session_id: FAKE_TAKEOVER_REF,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('RESTORE_CONFLICT');
    });
  });

  // ─── undo-overtime-takeover ───────────────────────────────────────────────
  //
  // Requires two sessions on the SAME court:
  //   - Active takeover session (actual_end_at IS NULL)
  //   - Ended displaced session (actual_end_at IS NOT NULL) with END event
  //     trigger='overtime_takeover' and takeover_session_id matching active session

  describe('undo-overtime-takeover', () => {
    it('ends takeover and restores displaced session, returns 200 with both IDs', async () => {
      await insertEndedSession(DISPLACED_FOR_UNDO, court1Id);
      await insertEndEvent(DISPLACED_FOR_UNDO, {
        trigger: 'overtime_takeover',
        takeover_session_id: TAKEOVER_SESSION,
      });
      await insertActiveSession(TAKEOVER_SESSION, court1Id);

      const res = await callFunction('undo-overtime-takeover', {
        device_id: KIOSK_DEVICE_ID,
        takeover_session_id: TAKEOVER_SESSION,
        displaced_session_id: DISPLACED_FOR_UNDO,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.endedSessionId).toBe(TAKEOVER_SESSION);
      expect(body.restoredSessionId).toBe(DISPLACED_FOR_UNDO);
      expect(typeof body.serverNow).toBe('string');

      // Verify takeover is ended
      const { data: takeover } = await adminClient
        .from('sessions')
        .select('actual_end_at')
        .eq('id', TAKEOVER_SESSION)
        .single();
      expect(takeover.actual_end_at).not.toBeNull();

      // Verify displaced is restored (active)
      const { data: displaced } = await adminClient
        .from('sessions')
        .select('actual_end_at')
        .eq('id', DISPLACED_FOR_UNDO)
        .single();
      expect(displaced.actual_end_at).toBeNull();
    });

    it('returns 200 ok:false UNDO_CONFLICT when the takeover session is already ended', async () => {
      await insertEndedSession(DISPLACED_FOR_UNDO, court1Id);
      await insertEndEvent(DISPLACED_FOR_UNDO, {
        trigger: 'overtime_takeover',
        takeover_session_id: TAKEOVER_SESSION,
      });
      await insertEndedSession(TAKEOVER_SESSION, court1Id); // already ended

      const res = await callFunction('undo-overtime-takeover', {
        device_id: KIOSK_DEVICE_ID,
        takeover_session_id: TAKEOVER_SESSION,
        displaced_session_id: DISPLACED_FOR_UNDO,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNDO_CONFLICT');
    });

    it('returns 200 ok:false when takeover_session_id is missing', async () => {
      const res = await callFunction('undo-overtime-takeover', {
        device_id: KIOSK_DEVICE_ID,
        displaced_session_id: DISPLACED_FOR_UNDO,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/takeover_session_id is required/i);
    });
  });

  // ─── update-session-tournament ────────────────────────────────────────────

  describe('update-session-tournament', () => {
    it('sets is_tournament=true on an active session, returns 200 with ok:true', async () => {
      await insertActiveSession(TOURNAMENT_SESSION, court1Id);

      const res = await callFunction('update-session-tournament', {
        device_id: KIOSK_DEVICE_ID,
        session_id: TOURNAMENT_SESSION,
        is_tournament: true,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.session.id).toBe(TOURNAMENT_SESSION);
      expect(body.session.is_tournament).toBe(true);
      expect(typeof body.serverNow).toBe('string');

      // Verify in DB
      const { data: s } = await adminClient
        .from('sessions')
        .select('is_tournament')
        .eq('id', TOURNAMENT_SESSION)
        .single();
      expect(s.is_tournament).toBe(true);
    });

    it('clears is_tournament=false on an active session', async () => {
      await insertActiveSession(TOURNAMENT_SESSION, court1Id);

      const res = await callFunction('update-session-tournament', {
        device_id: KIOSK_DEVICE_ID,
        session_id: TOURNAMENT_SESSION,
        is_tournament: false,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.session.is_tournament).toBe(false);
    });

    it('returns 200 ok:false when the session has already ended', async () => {
      await insertEndedSession(TOURNAMENT_SESSION, court1Id);

      const res = await callFunction('update-session-tournament', {
        device_id: KIOSK_DEVICE_ID,
        session_id: TOURNAMENT_SESSION,
        is_tournament: true,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/already ended/i);
    });

    it('returns 200 ok:false when session_id is missing', async () => {
      const res = await callFunction('update-session-tournament', {
        device_id: KIOSK_DEVICE_ID,
        is_tournament: true,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/session_id is required/i);
    });
  });
});
