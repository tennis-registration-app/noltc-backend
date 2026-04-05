/**
 * Integration tests for block management:
 * - update-block
 *
 * UUID namespace: d0000000-0000-0000-0000-000000012xxx
 *
 * Excluded (debug / utility — no meaningful business logic to test):
 * - debug-constraints: raw DB diagnostic endpoint, no auth gate, no business rule
 * - debug-query:       raw DB diagnostic endpoint, no auth gate, no business rule
 * - hello-world:       no-op test function deployed for smoke testing only
 * - fix-session:       one-time patch hardcoded to a specific session UUID, no parameters
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000012001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001'; // pre-seeded

const TEST_BLOCK_ID   = 'd0000000-0000-0000-0000-000000012010';
const TEST_BLOCK_2_ID = 'd0000000-0000-0000-0000-000000012011';

describe.skipIf(MISSING_ENV)('block management Edge Functions (integration)', () => {
  let adminClient: any;
  let court1Id: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: courts, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .eq('is_active', true)
      .order('court_number', { ascending: true })
      .limit(1);
    if (courtsError || !courts || courts.length < 1) {
      throw new Error(`Need at least 1 active court: ${courtsError?.message ?? 'not found'}`);
    }
    court1Id = courts[0].id;

    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (block-management)',
      device_token: 'test-admin-token-block-mgmt',
      is_active: true,
    });
  });

  afterEach(async () => {
    await adminClient.from('blocks').delete().in('id', [TEST_BLOCK_ID, TEST_BLOCK_2_ID]);
  });

  afterAll(async () => {
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function insertFutureBlock(
    blockId: string,
    courtId: string,
    blockType: string = 'lesson',
    options: { cancelled?: boolean } = {}
  ): Promise<void> {
    const now = new Date();
    const block: Record<string, unknown> = {
      id: blockId,
      court_id: courtId,
      block_type: blockType,
      title: 'Integration Test Block',
      starts_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      ends_at: new Date(now.getTime() + 120 * 60 * 1000).toISOString(),
      is_recurring: false,
      created_by_device_id: ADMIN_DEVICE_ID,
    };
    if (options.cancelled) {
      block.cancelled_at = new Date().toISOString();
    }
    const { error } = await adminClient.from('blocks').insert(block);
    if (error) throw new Error(`Failed to insert block ${blockId}: ${error.message}`);
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

  // ─── update-block ─────────────────────────────────────────────────────────

  describe('update-block', () => {
    it('updates the title of a future block, returns 200 ok:true with data.block shape', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id);

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        title: 'Updated Integration Test Block',
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.code).toBe('OK');
      expect(typeof body.serverNow).toBe('string');
      expect(body.data.block.id).toBe(TEST_BLOCK_ID);
      expect(body.data.block.title).toBe('Updated Integration Test Block');
      expect(typeof body.data.block.court_number).toBe('number');
      expect(typeof body.data.block.duration_minutes).toBe('number');
      expect(typeof body.data.block.starts_at).toBe('string');
      expect(typeof body.data.block.ends_at).toBe('string');
    });

    it('updates the block_type of a non-wet block to clinic', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id, 'lesson');

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        block_type: 'clinic',
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.block.block_type).toBe('clinic');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls update-block', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id);

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        title: 'Should Fail',
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 200 ok:false BLOCK_NOT_FOUND for a non-existent block_id', async () => {
      const res = await callFunction('update-block', {
        block_id: 'd0000000-0000-0000-0000-000000012099',
        title: 'Should Not Update',
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('BLOCK_NOT_FOUND');
    });

    it('returns 200 ok:false BLOCK_CANCELLED for a cancelled block', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id, 'lesson', { cancelled: true });

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        title: 'Should Not Update',
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('BLOCK_CANCELLED');
    });

    it('returns 200 ok:false NO_CHANGES when no update fields are provided', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id);

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        // No update fields
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('NO_CHANGES');
    });

    it('returns 200 ok:false INVALID_DATE_RANGE when ends_at is before starts_at', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id);
      const now = new Date();

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        starts_at: new Date(now.getTime() + 120 * 60 * 1000).toISOString(),
        ends_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), // ends before starts
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('INVALID_DATE_RANGE');
    });

    it('returns 200 ok:false CANNOT_CHANGE_WET_TYPE when trying to change a wet block type', async () => {
      await insertFutureBlock(TEST_BLOCK_ID, court1Id, 'wet');

      const res = await callFunction('update-block', {
        block_id: TEST_BLOCK_ID,
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        block_type: 'lesson', // cannot change wet to anything else
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('CANNOT_CHANGE_WET_TYPE');
    });
  });
});
