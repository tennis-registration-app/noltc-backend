/**
 * Integration tests for waitlist management:
 * - remove-from-waitlist  (admin only)
 * - clear-waitlist        (admin or kiosk)
 *
 * UUID namespace: d0000000-0000-0000-0000-000000013xxx
 *
 * NOTE: clear-waitlist cancels ALL 'waiting' entries globally. Tests use
 * positions 950/951 (well above realistic real-data positions) and assert
 * cancelledCount >= 2 rather than an exact value.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeWaitlistForMembers, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000013001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001'; // pre-seeded
const TEST_ACCOUNT_ID = 'd0000000-0000-0000-0000-000000013010';
const TEST_MEMBER_ID  = 'd0000000-0000-0000-0000-000000013011';

const WL_ENTRY_A = 'd0000000-0000-0000-0000-000000013020';
const WL_ENTRY_B = 'd0000000-0000-0000-0000-000000013021';

const POS_A = 950;
const POS_B = 951;

describe.skipIf(MISSING_ENV)('waitlist management Edge Functions (integration)', () => {
  let adminClient: any;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (waitlist-management)',
      device_token: 'test-admin-token-wl-mgmt',
      is_active: true,
    });

    await adminClient.from('accounts').upsert({
      id: TEST_ACCOUNT_ID,
      member_number: 'TEST-WLMGMT-001',
      account_name: 'Integration Test Account (waitlist-management)',
      status: 'active',
    });

    await adminClient.from('members').upsert({
      id: TEST_MEMBER_ID,
      account_id: TEST_ACCOUNT_ID,
      display_name: 'Integration Test Member (waitlist-management)',
      is_primary: true,
      status: 'active',
    });
  });

  afterEach(async () => {
    await safeCleanup('waitlist-management', async () => {
      await purgeWaitlistForMembers(adminClient, [TEST_MEMBER_ID], [WL_ENTRY_A, WL_ENTRY_B]);
    });
  });

  afterAll(async () => {
    await adminClient.from('members').delete().eq('id', TEST_MEMBER_ID);
    await adminClient.from('accounts').delete().eq('id', TEST_ACCOUNT_ID);
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function insertWaitlistEntry(entryId: string, position: number): Promise<void> {
    const { error: wlError } = await adminClient.from('waitlist').insert({
      id: entryId,
      group_type: 'singles',
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

  // ─── remove-from-waitlist ─────────────────────────────────────────────────

  describe('remove-from-waitlist', () => {
    it('removes a waiting entry, returns 200 ok:true with waitlistEntryId and board', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);

      const res = await callFunction('remove-from-waitlist', {
        device_id: ADMIN_DEVICE_ID,
        waitlist_entry_id: WL_ENTRY_A,
        reason: 'integration_test',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.waitlistEntryId).toBe(WL_ENTRY_A);
      expect(body.board).toBeDefined();
      expect(typeof body.serverNow).toBe('string');

      // Verify in DB
      const { data: entry } = await adminClient
        .from('waitlist')
        .select('status')
        .eq('id', WL_ENTRY_A)
        .single();
      expect(entry.status).toBe('cancelled');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls remove-from-waitlist', async () => {
      const res = await callFunction('remove-from-waitlist', {
        device_id: KIOSK_DEVICE_ID,
        waitlist_entry_id: WL_ENTRY_A,
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns HTTP 404 when the waitlist_entry_id does not exist', async () => {
      const res = await callFunction('remove-from-waitlist', {
        device_id: ADMIN_DEVICE_ID,
        waitlist_entry_id: 'd0000000-0000-0000-0000-000000013099',
      });

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('not_found');
    });

    it('returns HTTP 409 ENTRY_NOT_ACTIVE when entry is already cancelled', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);
      await adminClient.from('waitlist').update({ status: 'cancelled' }).eq('id', WL_ENTRY_A);

      const res = await callFunction('remove-from-waitlist', {
        device_id: ADMIN_DEVICE_ID,
        waitlist_entry_id: WL_ENTRY_A,
      });

      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('ENTRY_NOT_ACTIVE');
    });

    it('returns HTTP 400 MISSING_WAITLIST_ENTRY when waitlist_entry_id is absent', async () => {
      const res = await callFunction('remove-from-waitlist', {
        device_id: ADMIN_DEVICE_ID,
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('MISSING_WAITLIST_ENTRY');
    });
  });

  // ─── clear-waitlist ───────────────────────────────────────────────────────
  //
  // WARNING: This function cancels ALL 'waiting' entries globally, not just test
  // fixtures. Tests assert cancelledCount >= our seeded count, and verify our
  // specific entries are cancelled in the DB.

  describe('clear-waitlist', () => {
    it('cancels all waiting entries, returns 200 ok:true with cancelledCount >= 2', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);
      await insertWaitlistEntry(WL_ENTRY_B, POS_B);

      const res = await callFunction('clear-waitlist', {
        device_id: ADMIN_DEVICE_ID,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.cancelledCount).toBe('number');
      expect(body.cancelledCount).toBeGreaterThanOrEqual(2);
      expect(typeof body.serverNow).toBe('string');

      // Verify our specific entries are cancelled
      const { data: entries } = await adminClient
        .from('waitlist')
        .select('status')
        .in('id', [WL_ENTRY_A, WL_ENTRY_B]);
      for (const e of entries) {
        expect(e.status).toBe('cancelled');
      }
    });

    it('returns 200 ok:true with cancelledCount:0 when the waitlist is empty', async () => {
      // Prior test clears all entries; nothing inserted here
      const res = await callFunction('clear-waitlist', {
        device_id: ADMIN_DEVICE_ID,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.cancelledCount).toBe(0);
      expect(body.message).toMatch(/already empty/i);
    });

    it('kiosk device can also call clear-waitlist (admin and kiosk both allowed)', async () => {
      await insertWaitlistEntry(WL_ENTRY_A, POS_A);

      const res = await callFunction('clear-waitlist', {
        device_id: KIOSK_DEVICE_ID,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('returns HTTP 403 when an unregistered device_id is supplied', async () => {
      const res = await callFunction('clear-waitlist', {
        device_id: 'd0000000-0000-0000-0000-000000013099',
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns HTTP 400 when device_id is missing', async () => {
      const res = await callFunction('clear-waitlist', {});

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
    });
  });
});
