import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { purgeBlocksByIds, safeCleanup } from './_shared/cleanup';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

// UUID namespace: d0000000-0000-0000-0000-000000005xxx
const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000005001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';

// Timestamps well in the future to avoid operating-hours interference
function futureRange(offsetHours = 48, durationHours = 1): { starts_at: string; ends_at: string } {
  const start = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

describe.skipIf(MISSING_ENV)('create-block Edge Function (integration)', () => {
  let adminClient: any;
  let courtId: string;
  let courtNumber: number;
  // Track block IDs created by the function so we can clean them up
  const createdBlockIds: string[] = [];

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
    courtNumber = courts[0].court_number;

    // Insert admin device for these tests
    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (create-block)',
      device_token: 'test-admin-token-create-block',
      is_active: true,
    });
  });

  afterEach(async () => {
    await safeCleanup('create-block', async () => {
      const trackedIds = [...createdBlockIds];
      createdBlockIds.length = 0;

      const { data: strayBlocks } = await adminClient
        .from('blocks')
        .select('id')
        .eq('created_by_device_id', ADMIN_DEVICE_ID);
      const strayIds = (strayBlocks ?? []).map((b: any) => b.id);

      const allIds = Array.from(new Set([...trackedIds, ...strayIds]));
      await purgeBlocksByIds(adminClient, allIds);
    });
  });

  afterAll(async () => {
    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function callCreateBlock(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/create-block`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('creates a block and returns 200 with the block details and board', async () => {
    const { starts_at, ends_at } = futureRange(48, 1);

    const res = await callCreateBlock({
      court_id: courtId,
      block_type: 'maintenance',
      title: 'Integration Test Block',
      starts_at,
      ends_at,
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
    expect(body.data.block.court_id).toBe(courtId);
    expect(body.data.block.court_number).toBe(courtNumber);
    expect(body.data.block.block_type).toBe('maintenance');
    expect(body.data.block.title).toBe('Integration Test Block');
    expect(typeof body.data.block.id).toBe('string');
    expect(body.board).toBeDefined();
    expect(Array.isArray(body.board.courts)).toBe(true);

    // Track for cleanup
    createdBlockIds.push(body.data.block.id);

    // Verify the block exists in the database
    const { data: dbBlock } = await adminClient
      .from('blocks')
      .select('id, block_type, title, cancelled_at')
      .eq('id', body.data.block.id)
      .single();

    expect(dbBlock).toBeDefined();
    expect(dbBlock.block_type).toBe('maintenance');
    expect(dbBlock.title).toBe('Integration Test Block');
    expect(dbBlock.cancelled_at).toBeNull();
  });

  it('returns HTTP 403 UNAUTHORIZED when a non-admin device tries to create a block', async () => {
    const { starts_at, ends_at } = futureRange(72, 1);

    const res = await callCreateBlock({
      court_id: courtId,
      block_type: 'lesson',
      title: 'Should Be Rejected',
      starts_at,
      ends_at,
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
  });

  it('returns HTTP 200 with MISSING_COURT_ID when court_id is omitted', async () => {
    const { starts_at, ends_at } = futureRange(96, 1);

    const res = await callCreateBlock({
      block_type: 'clinic',
      title: 'No Court',
      starts_at,
      ends_at,
      device_id: ADMIN_DEVICE_ID,
      device_type: 'admin',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('MISSING_COURT_ID');
    expect(typeof body.message).toBe('string');
    expect(typeof body.serverNow).toBe('string');
    expect(body.data).toBeNull();
  });

  it('returns HTTP 200 with INVALID_DATE_RANGE when ends_at is before starts_at', async () => {
    const now = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const starts_at = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const ends_at = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString(); // ends before starts

    const res = await callCreateBlock({
      court_id: courtId,
      block_type: 'other',
      title: 'Bad Date Range',
      starts_at,
      ends_at,
      device_id: ADMIN_DEVICE_ID,
      device_type: 'admin',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INVALID_DATE_RANGE');
    expect(typeof body.message).toBe('string');
    expect(body.data).toBeNull();
  });
});
