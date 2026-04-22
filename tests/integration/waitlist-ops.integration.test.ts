/**
 * Integration tests for waitlist operations:
 * - reorder-waitlist  (admin only)
 * - defer-waitlist    (any registered device)
 * - cancel-waitlist   (any registered device)
 *
 * UUID namespace: d0000000-0000-0000-0000-000000010xxx
 *
 * Waitlist entries are inserted at high positions (900+) to avoid colliding
 * with real or other-test waiting entries when the reorder_waitlist RPC
 * validates new_position <= MAX(position) across all waiting entries.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeWaitlistForMembers, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000010001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000010010';
const TEST_MEMBER_ID = 'd0000000-0000-0000-0000-000000010011';

// Deterministic waitlist entry IDs
const WL_ENTRY_A = 'd0000000-0000-0000-0000-000000010020';
const WL_ENTRY_B = 'd0000000-0000-0000-0000-000000010021';

// Positions chosen to be higher than any realistic real-data position,
// so the reorder RPC's MAX(position) check always includes our entries.
const POS_A = 900;
const POS_B = 901;

describe.skipIf(MISSING_ENV)('waitlist ops Edge Functions (integration)', () => {
  let adminClient: any;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (waitlist-ops)',
      device_token: 'test-admin-token-waitlist-ops',
      is_active: true,
    });

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-WLOPS-001',
      account_name: 'Integration Test Account (waitlist-ops)',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (waitlist-ops)',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    await safeCleanup('waitlist-ops', async () => {
      await purgeWaitlistForMembers(adminClient, [TEST_MEMBER_ID], [WL_ENTRY_A, WL_ENTRY_B]);
    });
  });

  afterAll(async () => {
    await adminClient.from('members').delete().eq('id', TEST_MEMBER_ID);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function insertWaitlistEntry(
    entryId: string,
    position: number,
    groupType: 'singles' | 'doubles' = 'singles'
  ): Promise<void> {
    const { error: wlError } = await adminClient.from('waitlist').insert({
      id: entryId,
      group_type: groupType,
      position,
      status: 'waiting',
      created_by_device_id: KIOSK_DEVICE_ID,
    });
    if (wlError) throw new Error(`Failed to insert waitlist entry ${entryId}: ${wlError.message}`);

    const { error: wmError } = await adminClient.from('waitlist_members').insert({
      waitlist_id: entryId,
      member_id: TEST_MEMBER_ID,
      participant_type: 'member',
      account_id: TEST_ACCOUNT_ID,
    });
    if (wmError) throw new Error(`Failed to insert waitlist member for ${entryId}: ${wmError.message}`);
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

  // ─── reorder-waitlist ────────────────────────────────────────────────────

  describe('reorder-waitlist', () => {
    it('moves an entry from position 901 to 900, shifting the displaced entry up', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);
      await insertWaitlistEntry(WL_ENTRY_B, POS_B);

      // Move entry B from 901 → 900 (moving it ahead of entry A)
      const res = await callFunction('reorder-waitlist', {
        device_id: ADMIN_DEVICE_ID,
        entry_id: WL_ENTRY_B,
        new_position: POS_A,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.old_position).toBe(POS_B);
      expect(body.new_position).toBe(POS_A);
      expect(typeof body.serverNow).toBe('string');
      expect(body.board).toBeDefined();

      // Verify DB: entry B is now at 900, entry A was shifted to 901
      const { data: entryB } = await adminClient
        .from('waitlist')
        .select('position')
        .eq('id', WL_ENTRY_B)
        .single();
      const { data: entryA } = await adminClient
        .from('waitlist')
        .select('position')
        .eq('id', WL_ENTRY_A)
        .single();

      expect(entryB.position).toBe(POS_A);
      expect(entryA.position).toBe(POS_B);
    });

    it('returns HTTP 403 when a non-admin device calls reorder-waitlist', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);

      const res = await callFunction('reorder-waitlist', {
        device_id: KIOSK_DEVICE_ID,
        entry_id: WL_ENTRY_A,
        new_position: POS_A,
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
    });

    it('returns HTTP 400 when new_position is missing', async () => {
      const res = await callFunction('reorder-waitlist', {
        device_id: ADMIN_DEVICE_ID,
        entry_id: WL_ENTRY_A,
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
    });
  });

  // ─── defer-waitlist ──────────────────────────────────────────────────────

  describe('defer-waitlist', () => {
    it('defers a waiting entry and returns 200 with deferred: true', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);

      const res = await callFunction('defer-waitlist', {
        waitlist_id: WL_ENTRY_A,
        deferred: true,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.waitlist.id).toBe(WL_ENTRY_A);
      expect(body.waitlist.deferred).toBe(true);
      expect(body.waitlist.position).toBe(POS_A);
      expect(typeof body.serverNow).toBe('string');

      // Verify in DB
      const { data: entry } = await adminClient
        .from('waitlist')
        .select('deferred')
        .eq('id', WL_ENTRY_A)
        .single();
      expect(entry.deferred).toBe(true);
    });

    it('un-defers an entry by setting deferred: false', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);

      // First defer it
      await callFunction('defer-waitlist', {
        waitlist_id: WL_ENTRY_A,
        deferred: true,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      // Then un-defer it
      const res = await callFunction('defer-waitlist', {
        waitlist_id: WL_ENTRY_A,
        deferred: false,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.waitlist.deferred).toBe(false);

      // Verify in DB
      const { data: entry } = await adminClient
        .from('waitlist')
        .select('deferred')
        .eq('id', WL_ENTRY_A)
        .single();
      expect(entry.deferred).toBe(false);
    });

    it('returns 200 with ok: false when entry is not found', async () => {
      const nonExistentId = 'd0000000-0000-0000-0000-000000010099';
      const res = await callFunction('defer-waitlist', {
        waitlist_id: nonExistentId,
        deferred: true,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ─── cancel-waitlist ─────────────────────────────────────────────────────

  describe('cancel-waitlist', () => {
    it('cancels a waiting entry and returns 200 with status: cancelled', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);

      const res = await callFunction('cancel-waitlist', {
        waitlist_id: WL_ENTRY_A,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.waitlist.id).toBe(WL_ENTRY_A);
      expect(body.waitlist.status).toBe('cancelled');
      expect(body.waitlist.previous_position).toBe(POS_A);
      expect(Array.isArray(body.waitlist.participants)).toBe(true);
      expect(typeof body.positions_updated).toBe('number');
      expect(typeof body.serverNow).toBe('string');

      // Verify in DB
      const { data: entry } = await adminClient
        .from('waitlist')
        .select('status')
        .eq('id', WL_ENTRY_A)
        .single();
      expect(entry.status).toBe('cancelled');
    });

    it('reorders the entry behind the cancelled one (positions_updated: 1)', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A); // position 900 — will be cancelled
      await insertWaitlistEntry(WL_ENTRY_B, POS_B); // position 901 — should shift to 900

      const res = await callFunction('cancel-waitlist', {
        waitlist_id: WL_ENTRY_A,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.positions_updated).toBeGreaterThanOrEqual(1);

      // Entry B should have moved from 901 to 900
      const { data: entryB } = await adminClient
        .from('waitlist')
        .select('position, status')
        .eq('id', WL_ENTRY_B)
        .single();

      expect(entryB.status).toBe('waiting');
      expect(entryB.position).toBe(POS_A); // shifted from 901 → 900
    });

    it('returns 200 with ok: false when entry is not found', async () => {
      const nonExistentId = 'd0000000-0000-0000-0000-000000010098';
      const res = await callFunction('cancel-waitlist', {
        waitlist_id: nonExistentId,
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/not found/i);
    });
  });
});
