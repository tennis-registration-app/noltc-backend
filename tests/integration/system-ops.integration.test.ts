/**
 * Integration tests for system operations:
 * - update-system-settings
 * - generate-location-token
 * - cleanup-sessions
 * - auto-clear-sessions
 * - export-transactions
 *
 * UUID namespace: d0000000-0000-0000-0000-000000014xxx
 *
 * Cleanup notes:
 * - update-system-settings: ball_price_cents is saved in beforeAll and restored in afterAll
 * - operating_hours_override: far-future date '2099-12-31' cleaned up in afterEach
 * - export-transactions: exports and export_items created by ADMIN_DEVICE_ID are deleted in afterAll
 * - generate-location-token: location_tokens created by ADMIN_DEVICE_ID are deleted in afterAll
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DEVICE_ID = 'd0000000-0000-0000-0000-000000014001';
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001'; // pre-seeded

const OVERRIDE_TEST_DATE = '2099-12-31'; // far-future date — safe for override tests

describe.skipIf(MISSING_ENV)('system ops Edge Functions (integration)', () => {
  let adminClient: any;
  let originalBallPriceCents: string;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await adminClient.from('devices').upsert({
      id: ADMIN_DEVICE_ID,
      device_type: 'admin',
      device_name: 'Integration Test Admin Device (system-ops)',
      device_token: 'test-admin-token-system-ops',
      is_active: true,
    });

    // Save current ball_price_cents so we can restore it
    const { data: setting } = await adminClient
      .from('system_settings')
      .select('value')
      .eq('key', 'ball_price_cents')
      .single();
    originalBallPriceCents = setting?.value ?? '300';
  });

  afterEach(async () => {
    // Clean up any override we created for the test date
    await adminClient
      .from('operating_hours_overrides')
      .delete()
      .eq('date', OVERRIDE_TEST_DATE);
  });

  afterAll(async () => {
    // Restore ball_price_cents
    await adminClient
      .from('system_settings')
      .update({ value: originalBallPriceCents })
      .eq('key', 'ball_price_cents');

    // Clean up exports and export_items created by the test device
    const { data: exports } = await adminClient
      .from('exports')
      .select('id')
      .eq('created_by_device_id', ADMIN_DEVICE_ID);
    if (exports && exports.length > 0) {
      const exportIds = exports.map((e: any) => e.id);
      await adminClient.from('export_items').delete().in('export_id', exportIds);
      await adminClient.from('exports').delete().in('id', exportIds);
    }

    // Clean up location_tokens created by the test device
    await adminClient.from('location_tokens').delete().eq('created_by_device_id', ADMIN_DEVICE_ID);

    await adminClient.from('devices').delete().eq('id', ADMIN_DEVICE_ID);
  });

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }

  // ─── update-system-settings ───────────────────────────────────────────────

  describe('update-system-settings', () => {
    it('updates ball_price_cents and returns 200 ok:true with updated.settings', async () => {
      const res = await post('update-system-settings', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        settings: { ball_price_cents: '499' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.updated.settings.ball_price_cents).toBe('499');

      // Verify in DB
      const { data: setting } = await adminClient
        .from('system_settings')
        .select('value')
        .eq('key', 'ball_price_cents')
        .single();
      expect(setting.value).toBe('499');
    });

    it('creates an operating_hours_override for the far-future test date', async () => {
      const res = await post('update-system-settings', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        operating_hours_override: {
          date: OVERRIDE_TEST_DATE,
          is_closed: true,
          reason: 'Integration test override',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.updated.operating_hours_override).toBeDefined();
      expect(body.updated.operating_hours_override.date).toBe(OVERRIDE_TEST_DATE);
      expect(body.updated.operating_hours_override.is_closed).toBe(true);

      // Verify in DB
      const { data: override } = await adminClient
        .from('operating_hours_overrides')
        .select('is_closed, reason')
        .eq('date', OVERRIDE_TEST_DATE)
        .single();
      expect(override.is_closed).toBe(true);
      expect(override.reason).toBe('Integration test override');
    });

    it('deletes an existing override and returns 200 ok:true', async () => {
      // First create the override
      await adminClient.from('operating_hours_overrides').insert({
        date: OVERRIDE_TEST_DATE,
        is_closed: true,
        reason: 'to be deleted',
        created_by_device_id: ADMIN_DEVICE_ID,
      });

      const res = await post('update-system-settings', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        delete_override: OVERRIDE_TEST_DATE,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.updated.deleted_override).toBe(OVERRIDE_TEST_DATE);

      // Verify override is gone from DB
      const { data: override } = await adminClient
        .from('operating_hours_overrides')
        .select('date')
        .eq('date', OVERRIDE_TEST_DATE);
      expect(override).toHaveLength(0);
    });

    it('returns HTTP 400 ok:false when a non-admin device calls update-system-settings', async () => {
      const res = await post('update-system-settings', {
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
        settings: { ball_price_cents: '100' },
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/admin/i);
    });

    it('returns HTTP 400 ok:false for an invalid settings key', async () => {
      const res = await post('update-system-settings', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        settings: { invalid_key: '999' },
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/invalid settings key/i);
    });

    it('returns HTTP 400 ok:false when no update fields are provided', async () => {
      const res = await post('update-system-settings', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
    });
  });

  // ─── generate-location-token ──────────────────────────────────────────────

  describe('generate-location-token', () => {
    it('generates a token from a kiosk device, returns 200 ok:true with 32-char token and expiresAt', async () => {
      const res = await post('generate-location-token', {
        device_id: KIOSK_DEVICE_ID,
        validity_minutes: 5,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBe(32);
      expect(typeof body.expiresAt).toBe('string');
      expect(typeof body.serverNow).toBe('string');
      // expiresAt should be in the future
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('generates a token from an admin device', async () => {
      const res = await post('generate-location-token', {
        device_id: ADMIN_DEVICE_ID,
        validity_minutes: 10,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.token.length).toBe(32);
    });

    it('returns HTTP 400 when device_id is missing', async () => {
      const res = await post('generate-location-token', {});

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('MISSING_DEVICE');
    });

    it('returns HTTP 401 for an unregistered device_id', async () => {
      const res = await post('generate-location-token', {
        device_id: 'd0000000-0000-0000-0000-000000014099',
      });

      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('INVALID_DEVICE');
    });
  });

  // ─── cleanup-sessions ─────────────────────────────────────────────────────

  describe('cleanup-sessions', () => {
    it('returns 200 ok:true with session diagnostic counts when called by admin', async () => {
      const res = await post('cleanup-sessions', {
        device_id: ADMIN_DEVICE_ID,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.sessionsChecked).toBe('number');
      expect(typeof body.orphanedFixed).toBe('number');
      expect(typeof body.duplicatesEnded).toBe('number');
      expect(typeof body.message).toBe('string');
    });

    it('returns HTTP 403 UNAUTHORIZED when a non-admin device calls cleanup-sessions', async () => {
      const res = await post('cleanup-sessions', {
        device_id: KIOSK_DEVICE_ID,
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns HTTP 400 MISSING_DEVICE_ID when device_id is absent', async () => {
      const res = await post('cleanup-sessions', {});

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('MISSING_DEVICE_ID');
    });
  });

  // ─── auto-clear-sessions ──────────────────────────────────────────────────
  //
  // No auth required — this is a cron-callable endpoint.
  // Tests only verify the response envelope; the actual clearing behavior depends
  // on the auto_clear_enabled setting and stale session state at the time of the call.

  describe('auto-clear-sessions', () => {
    it('returns 200 ok:true regardless of whether auto-clear is enabled or disabled', async () => {
      const res = await post('auto-clear-sessions', {});

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.cleared).toBe('number');
      expect(typeof body.message).toBe('string');
      expect(typeof body.serverNow).toBe('string');
    });

    it('response cleared field is always a non-negative number', async () => {
      const res = await post('auto-clear-sessions', {});
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      expect(body.cleared).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── export-transactions ──────────────────────────────────────────────────

  describe('export-transactions', () => {
    it('returns 200 ok:true with export_id and record_count for a date range with no transactions', async () => {
      // Use a far-past date range guaranteed to have no transactions in the test environment
      const res = await post('export-transactions', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        date_range_start: '2000-01-01',
        date_range_end: '2000-01-02',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.export_id).toBe('string');
      expect(typeof body.record_count).toBe('number');
      expect(body.record_count).toBe(0);
      expect(body.csv).toBeNull();
    });

    it('response includes summary object with expected keys when there are transactions', async () => {
      // Use a broader recent date range — may or may not have transactions;
      // the endpoint always returns ok:true with the correct summary shape
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const res = await post('export-transactions', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        date_range_start: startDate,
        date_range_end: endDate,
        include_already_exported: true,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.export_id).toBe('string');
      expect(typeof body.record_count).toBe('number');

      // If records were found, verify summary and CSV structure
      if (body.record_count > 0) {
        expect(body.summary).toBeDefined();
        expect(typeof body.summary.total_transactions).toBe('number');
        expect(typeof body.summary.guest_fees).toBe('number');
        expect(typeof body.summary.ball_purchases).toBe('number');
        expect(typeof body.csv).toBe('string');
        expect(body.csv).toMatch(/MemberNumber,TransactionDate/);
      }
    });

    it('returns HTTP 400 ok:false when a non-admin device calls export-transactions', async () => {
      const res = await post('export-transactions', {
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk',
        date_range_start: '2000-01-01',
        date_range_end: '2000-01-02',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/admin/i);
    });

    it('returns HTTP 400 ok:false when date_range_start is missing', async () => {
      const res = await post('export-transactions', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        date_range_end: '2000-01-02',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
    });

    it('returns HTTP 400 ok:false when date_range_end is before date_range_start', async () => {
      const res = await post('export-transactions', {
        device_id: ADMIN_DEVICE_ID,
        device_type: 'admin',
        date_range_start: '2025-06-01',
        date_range_end: '2025-05-01', // before start
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/after/i);
    });
  });
});
