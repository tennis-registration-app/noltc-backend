import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeBlocksByIds, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

// UUID namespace: d0000000-0000-0000-0000-000000006xxx
const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000006001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';

// Pre-inserted test block IDs
const TEST_BLOCK_IDS = {
  b1: 'd0000000-0000-0000-0000-000000006010',
  b2: 'd0000000-0000-0000-0000-000000006011',
};

describe.skipIf(MISSING_ENV)('cancel-block Edge Function (integration)', () => {
  let adminClient: any;
  let courtId: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch a real court to use in tests
    const { data: courts, error: courtsError } = await adminClient
      .from('courts')
      .select('id, court_number')
      .eq('is_active', true)
      .order('court_number', { ascending: true })
      .limit(1);

    if (courtsError || !courts || courts.length === 0) {
      throw new Error(`Failed to fetch a test court: ${courtsError?.message ?? 'no active courts found'}`);
    }

    courtId = courts[0].id;

    // Insert admin device for these tests
    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (cancel-block)',
      device_token: 'test-admin-token-cancel-block',
      is_active: true,
    });
  });

  afterEach(async () => {
    await safeCleanup('cancel-block', async () => {
      await purgeBlocksByIds(adminClient, Object.values(TEST_BLOCK_IDS));
    });
  });

  afterAll(async () => {
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function insertTestBlock(blockId: string): Promise<void> {
    const starts_at = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const ends_at = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();

    const { error } = await adminClient.from('blocks').insert({
      id: blockId,
      court_id: courtId,
      block_type: 'maintenance',
      title: 'Integration Test Block (cancel-block)',
      starts_at,
      ends_at,
      is_recurring: false,
      created_by_device_id: ADMIN_DEVICE_ID,
    });

    if (error) {
      throw new Error(`Failed to insert test block ${blockId}: ${error.message}`);
    }
  }

  async function callCancelBlock(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/cancel-block`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('cancels a block and returns 200 with block details and board', async () => {
    await insertTestBlock(TEST_BLOCK_IDS.b1);

    const res = await callCancelBlock({
      block_id: TEST_BLOCK_IDS.b1,
      device_id: ADMIN_DEVICE_ID,
      device_type: 'admin',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.code).toBe('OK');
    expect(typeof body.serverNow).toBe('string');
    expect(body.data).toBeDefined();
    expect(body.data.block).toBeDefined();
    expect(body.data.block.id).toBe(TEST_BLOCK_IDS.b1);
    expect(typeof body.data.block.cancelled_at).toBe('string');
    expect(body.board).toBeDefined();
    expect(Array.isArray(body.board.courts)).toBe(true);

    // Verify the soft delete in the database
    const { data: dbBlock } = await adminClient
      .from('blocks')
      .select('id, cancelled_at')
      .eq('id', TEST_BLOCK_IDS.b1)
      .single();

    expect(dbBlock).toBeDefined();
    expect(dbBlock.cancelled_at).not.toBeNull();
  });

  it('returns HTTP 403 UNAUTHORIZED when a non-admin device tries to cancel a block', async () => {
    await insertTestBlock(TEST_BLOCK_IDS.b1);

    const res = await callCancelBlock({
      block_id: TEST_BLOCK_IDS.b1,
      device_id: KIOSK_DEVICE_ID,
      device_type: 'kiosk',
    });

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
    expect(body.data).toBeNull();

    // Block must still be active (not soft-deleted)
    const { data: dbBlock } = await adminClient
      .from('blocks')
      .select('id, cancelled_at')
      .eq('id', TEST_BLOCK_IDS.b1)
      .single();

    expect(dbBlock.cancelled_at).toBeNull();
  });

  it('returns HTTP 200 with ALREADY_CANCELLED when cancelling an already-cancelled block', async () => {
    await insertTestBlock(TEST_BLOCK_IDS.b2);

    // First cancel — should succeed
    const first = await callCancelBlock({
      block_id: TEST_BLOCK_IDS.b2,
      device_id: ADMIN_DEVICE_ID,
      device_type: 'admin',
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.ok).toBe(true);

    // Second cancel — should be denied
    const res = await callCancelBlock({
      block_id: TEST_BLOCK_IDS.b2,
      device_id: ADMIN_DEVICE_ID,
      device_type: 'admin',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('ALREADY_CANCELLED');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
    expect(body.data).toBeNull();
  });
});
