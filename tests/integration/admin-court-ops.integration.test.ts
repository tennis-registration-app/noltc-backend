/**
 * Integration tests for admin court operations:
 * - clear-all-courts
 * - mark-wet-courts
 * - clear-wet-courts
 *
 * UUID namespace: d0000000-0000-0000-0000-000000009xxx
 * All three functions require device_type = 'admin'.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeActiveTestSessionsOnCourts, purgeBlocksByIds, purgeSessionsForMembers, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000009001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000009010';
const TEST_MEMBER_ID = 'd0000000-0000-0000-0000-000000009011';

const TEST_SESSION_IDS = {
  s1: 'd0000000-0000-0000-0000-000000009020',
  s2: 'd0000000-0000-0000-0000-000000009021',
  s3: 'd0000000-0000-0000-0000-000000009022',
};

const TEST_BLOCK_ID = 'd0000000-0000-0000-0000-000000009030';

describe.skipIf(MISSING_ENV)('admin court ops Edge Functions (integration)', () => {
  let adminClient: any;
  let court1Id: string;
  let court2Id: string;
  let court3Id: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courts, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .eq('is_active', true)
      .order('court_number', { ascending: true })
      .limit(3);

    if (courtsError || !courts || courts.length < 3) {
      throw new Error(`Need at least 3 active courts: ${courtsError?.message ?? 'not enough'}`);
    }

    court1Id = courts[0].id;
    court2Id = courts[1].id;
    court3Id = courts[2].id;

    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (admin-court-ops)',
      device_token: 'test-admin-token-court-ops',
      is_active: true,
    });

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-CRTOPS-001',
      account_name: 'Integration Test Account (admin-court-ops)',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (admin-court-ops)',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    await safeCleanup('admin-court-ops', async () => {
      await purgeSessionsForMembers(adminClient, [TEST_MEMBER_ID], Object.values(TEST_SESSION_IDS));

      const { data: adminBlocks } = await adminClient
        .from('blocks')
        .select('id')
        .eq('created_by_device_id', ADMIN_DEVICE_ID);
      const blockIds = Array.from(new Set([
        TEST_BLOCK_ID,
        ...((adminBlocks ?? []).map((b: any) => b.id) as string[]),
      ]));
      await purgeBlocksByIds(adminClient, blockIds);
      await purgeActiveTestSessionsOnCourts(adminClient, [court1Id, court2Id, court3Id]);
    });
  });

  afterAll(async () => {
    await adminClient.from('members').delete().eq('id', TEST_MEMBER_ID);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
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
      participant_key: `m:${TEST_MEMBER_ID}:${sessionId}`,
    });
    if (error) throw new Error(`Failed to insert session ${sessionId}: ${error.message}`);
  }

  async function insertActiveWetBlock(blockId: string, courtId: string): Promise<void> {
    const now = new Date();
    const { error } = await adminClient.from('blocks').insert({
      id: blockId,
      court_id: courtId,
      block_type: 'wet',
      title: 'WET COURT',
      starts_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      ends_at: new Date(now.getTime() + 715 * 60 * 1000).toISOString(),
      is_recurring: false,
      created_by_device_id: ADMIN_DEVICE_ID,
    });
    if (error) throw new Error(`Failed to insert wet block ${blockId}: ${error.message}`);
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

  // ─── clear-all-courts ────────────────────────────────────────────────────

  describe('clear-all-courts', () => {
    it('ends all active sessions and returns 200 with sessionsEnded count and board', async () => {
      await insertSession(TEST_SESSION_IDS.s1, court1Id);
      await insertSession(TEST_SESSION_IDS.s2, court2Id);

      const res = await callFunction('clear-all-courts', {
        device_id: ADMIN_DEVICE_ID,
        reason: 'integration_test',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.sessionsEnded).toBe('number');
      expect(body.sessionsEnded).toBeGreaterThanOrEqual(2);
      expect(typeof body.serverNow).toBe('string');
      expect(body.board).toBeDefined();
      expect(Array.isArray(body.board.courts)).toBe(true);

      // Verify both sessions now have actual_end_at set
      const { data: s1 } = await adminClient
        .from('sessions')
        .select('actual_end_at')
        .eq('id', TEST_SESSION_IDS.s1)
        .single();
      const { data: s2 } = await adminClient
        .from('sessions')
        .select('actual_end_at')
        .eq('id', TEST_SESSION_IDS.s2)
        .single();

      expect(s1.actual_end_at).not.toBeNull();
      expect(s2.actual_end_at).not.toBeNull();
    });

    it('returns 200 with sessionsEnded: 0 when no sessions are active', async () => {
      // No sessions inserted — courts are empty
      const res = await callFunction('clear-all-courts', {
        device_id: ADMIN_DEVICE_ID,
        reason: 'integration_test_empty',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.sessionsEnded).toBe(0);
      expect(typeof body.serverNow).toBe('string');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls clear-all-courts', async () => {
      const res = await callFunction('clear-all-courts', {
        device_id: KIOSK_DEVICE_ID,
        reason: 'should_fail',
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(typeof body.serverNow).toBe('string');
    });
  });

  // ─── mark-wet-courts ─────────────────────────────────────────────────────

  describe('mark-wet-courts', () => {
    it('marks specific courts as wet and returns 200 with blocks_created count', async () => {
      const res = await callFunction('mark-wet-courts', {
        device_id: ADMIN_DEVICE_ID,
        court_ids: [court3Id],
        duration_minutes: 60,
        reason: 'Integration Test Wet Court',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.courts_marked).toBe(1);
      expect(body.blocks_created).toBe(1);
      expect(typeof body.ends_at).toBe('string');
      expect(body.duration_minutes).toBe(60);
      expect(typeof body.serverNow).toBe('string');

      // Verify the wet block exists in the DB
      const { data: blocks } = await adminClient
        .from('blocks')
        .select('id, block_type, title, cancelled_at')
        .eq('court_id', court3Id)
        .eq('block_type', 'wet')
        .is('cancelled_at', null);

      expect(blocks).toBeDefined();
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0].block_type).toBe('wet');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls mark-wet-courts', async () => {
      const res = await callFunction('mark-wet-courts', {
        device_id: KIOSK_DEVICE_ID,
        court_ids: [court1Id],
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(typeof body.serverNow).toBe('string');
    });
  });

  // ─── clear-wet-courts ────────────────────────────────────────────────────

  describe('clear-wet-courts', () => {
    it('cancels active wet blocks and returns 200 with blocks_cleared count', async () => {
      await insertActiveWetBlock(TEST_BLOCK_ID, court1Id);

      const res = await callFunction('clear-wet-courts', {
        device_id: ADMIN_DEVICE_ID,
        court_ids: [court1Id],
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.blocks_cleared).toBe(1);
      expect(Array.isArray(body.court_numbers)).toBe(true);
      expect(typeof body.serverNow).toBe('string');

      // Verify the block now has cancelled_at set
      const { data: block } = await adminClient
        .from('blocks')
        .select('cancelled_at')
        .eq('id', TEST_BLOCK_ID)
        .single();

      expect(block.cancelled_at).not.toBeNull();
    });

    it('returns 200 with blocks_cleared: 0 when no active wet blocks exist', async () => {
      // No wet block inserted — court1 has no active wet block
      const res = await callFunction('clear-wet-courts', {
        device_id: ADMIN_DEVICE_ID,
        court_ids: [court1Id],
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.blocks_cleared).toBe(0);
      expect(typeof body.serverNow).toBe('string');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls clear-wet-courts', async () => {
      const res = await callFunction('clear-wet-courts', {
        device_id: KIOSK_DEVICE_ID,
        court_ids: [court1Id],
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(typeof body.serverNow).toBe('string');
    });
  });
});
