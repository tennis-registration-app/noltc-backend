/**
 * Integration tests for read-only member / settings / court-status endpoints:
 * - get-members
 * - get-settings
 * - get-court-status
 *
 * None of these require a device ID or admin auth.
 */
import { describe, it, expect } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

function authHeaders() {
  return { Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
}

describe.skipIf(MISSING_ENV)('read endpoints — members / settings / court-status (integration)', () => {

  // ─── get-members ──────────────────────────────────────────────────────────

  describe('get-members', () => {
    it('returns 200 with ok:true and a members array', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-members`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.count).toBe('number');
      expect(Array.isArray(body.members)).toBe(true);
    });

    it('member entries have the expected fields', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-members`, {
        headers: authHeaders(),
      });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      expect(body.members.length).toBeGreaterThan(0);

      const m = body.members[0];
      expect(typeof m.id).toBe('string');
      expect(typeof m.display_name).toBe('string');
      expect(typeof m.account_id).toBe('string');
      expect(typeof m.uncleared_streak).toBe('number');
    });

    it('returns filtered results for a search query', async () => {
      // Any single letter will match some members or return empty — either is valid
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-members?search=a`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.count).toBe('number');
      expect(Array.isArray(body.members)).toBe(true);
      // All returned names must contain the search term (case-insensitive)
      for (const m of body.members) {
        expect(m.display_name.toLowerCase()).toContain('a');
      }
    });

    it('returns ok:true with count:0 for an unknown member_number', async () => {
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/get-members?member_number=NONEXISTENT-99999`,
        { headers: authHeaders() }
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.count).toBe(0);
      expect(body.members).toHaveLength(0);
    });
  });

  // ─── get-settings ─────────────────────────────────────────────────────────

  describe('get-settings', () => {
    it('returns 200 with ok:true and the settings envelope', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-settings`, {
        method: 'POST',
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.code).toBe('OK');
      expect(typeof body.serverNow).toBe('string');
      expect(body.data).toBeDefined();
    });

    it('response data includes settings object with known keys', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-settings`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      const s = body.data.settings;
      expect(typeof s).toBe('object');
      // Numeric conversions should have happened
      expect(typeof s.ball_price_cents).toBe('number');
      expect(typeof s.ball_price_dollars).toBe('string');
      expect(typeof s.guest_fee_weekday_cents).toBe('number');
      expect(typeof s.guest_fee_weekday_dollars).toBe('string');
    });

    it('response data includes operating_hours array with 7 entries', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-settings`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data.operating_hours)).toBe(true);
      expect(body.data.operating_hours.length).toBe(7);

      const day = body.data.operating_hours[0];
      expect(typeof day.day_of_week).toBe('number');
      expect(typeof day.day_name).toBe('string');
    });

    it('response data includes upcoming_overrides array', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-settings`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data.upcoming_overrides)).toBe(true);
    });
  });

  // ─── get-court-status ─────────────────────────────────────────────────────
  //
  // NOTE: get-court-status reads from `court_availability_view` and
  // `active_sessions_view`. These views are defined in the baseline migration
  // but have not been added to this Supabase project's PostgREST schema cache.
  // Until the views are deployed (supabase db push + reload schema), this
  // function will return HTTP 400 with an error about the missing view.
  //
  // The happy-path shape tests are skipped. The error-state test documents the
  // current live behavior so that future deployment can be verified by removing
  // the skip from the tests above.

  describe('get-court-status', () => {
    it('returns HTTP 400 because court_availability_view is not deployed [views pending]', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-court-status`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/court_availability_view/i);
    });

    it.todo('returns 200 with ok:true and courts array [requires court_availability_view deployed]');
    it.todo('courts array entries have court_id, court_number, status, session, block fields [requires views]');
  });
});
