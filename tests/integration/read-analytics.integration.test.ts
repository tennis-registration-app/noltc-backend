/**
 * Integration tests for read-only analytics / history endpoints:
 * - get-analytics
 * - get-usage-analytics
 * - get-usage-comparison
 * - get-transactions
 * - get-session-history
 * - get-frequent-partners
 *
 * None of these require device auth. All are read-only.
 */
import { describe, it, expect } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

const AUTH = { Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
const JSON_HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

async function post(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function get(path: string, params: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${SUPABASE_URL}/functions/v1/${path}?${qs}` : `${SUPABASE_URL}/functions/v1/${path}`;
  return fetch(url, { headers: AUTH });
}

// A stable 7-day window in the recent past for analytics queries
const END_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const START_DATE = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

describe.skipIf(MISSING_ENV)('read endpoints — analytics / history (integration)', () => {

  // ─── get-analytics ────────────────────────────────────────────────────────

  describe('get-analytics', () => {
    it('returns 200 with ok:true using default date range', async () => {
      const res = await post('get-analytics');

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.serverNow).toBe('string');
      expect(body.range).toBeDefined();
      expect(typeof body.range.start).toBe('string');
      expect(typeof body.range.end).toBe('string');
    });

    it('response includes summary, heatmap, waitlist, waitlistHeatmap arrays', async () => {
      const res = await post('get-analytics');
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      const s = body.summary;
      expect(typeof s.sessions).toBe('number');
      expect(typeof s.courtHoursUsed).toBe('number');
      expect(typeof s.utilizationPct).toBe('number');
      expect(Array.isArray(body.heatmap)).toBe(true);
      expect(Array.isArray(body.waitlist)).toBe(true);
      expect(Array.isArray(body.waitlistHeatmap)).toBe(true);
    });

    it('returns 200 with explicit date range', async () => {
      const res = await post('get-analytics', { start: START_DATE, end: END_DATE });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.range.start).toBe(START_DATE);
      expect(body.range.end).toBe(END_DATE);
    });
  });

  // ─── get-usage-analytics ─────────────────────────────────────────────────

  describe('get-usage-analytics', () => {
    it('returns 200 with ok:true and heatmap array using default days', async () => {
      const res = await post('get-usage-analytics');

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.heatmap)).toBe(true);
      expect(body.daysAnalyzed).toBe(90);
      expect(typeof body.serverNow).toBe('string');
    });

    it('respects an explicit days parameter and clamps to valid range', async () => {
      const res = await post('get-usage-analytics', { days: 30 });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      expect(body.daysAnalyzed).toBe(30);
      expect(Array.isArray(body.heatmap)).toBe(true);
    });

    it('clamps days below minimum to 7', async () => {
      const res = await post('get-usage-analytics', { days: 1 });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      expect(body.daysAnalyzed).toBe(7); // clamped from 1 → 7
    });
  });

  // ─── get-usage-comparison ────────────────────────────────────────────────

  describe('get-usage-comparison', () => {
    it('returns 200 with primary buckets for usage metric', async () => {
      const res = await post('get-usage-comparison', {
        metric: 'usage',
        primaryStart: START_DATE,
        primaryEnd: END_DATE,
        granularity: 'auto',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.metric).toBe('usage');
      expect(body.unit).toBe('hours');
      expect(typeof body.granularity).toBe('string');
      expect(body.primary).toBeDefined();
      expect(body.primary.startDate).toBe(START_DATE);
      expect(body.primary.endDate).toBe(END_DATE);
      expect(Array.isArray(body.primary.buckets)).toBe(true);
      expect(body.comparison).toBeNull(); // no comparisonStart provided
    });

    it('returns comparison data when comparisonStart is provided', async () => {
      // Use a period 2 weeks earlier as comparison
      const compStart = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const res = await post('get-usage-comparison', {
        metric: 'waittime',
        primaryStart: START_DATE,
        primaryEnd: END_DATE,
        granularity: 'day',
        comparisonStart: compStart,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.metric).toBe('waittime');
      expect(body.unit).toBe('minutes');
      expect(body.comparison).not.toBeNull();
      expect(typeof body.comparison.startDate).toBe('string');
      expect(Array.isArray(body.comparison.buckets)).toBe(true);
    });

    it('returns HTTP 400 for an invalid metric value', async () => {
      const res = await post('get-usage-comparison', {
        metric: 'invalid_metric',
        primaryStart: START_DATE,
        primaryEnd: END_DATE,
        granularity: 'auto',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(typeof body.error).toBe('string');
    });

    it('returns HTTP 400 when primaryStart or primaryEnd are missing', async () => {
      const res = await post('get-usage-comparison', {
        metric: 'usage',
        granularity: 'auto',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(typeof body.error).toBe('string');
    });
  });

  // ─── get-transactions ────────────────────────────────────────────────────

  describe('get-transactions', () => {
    it('returns 200 with ok:true, summary object, and transactions array', async () => {
      const res = await get('get-transactions');

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.summary).toBeDefined();
      expect(typeof body.summary.total_count).toBe('number');
      expect(typeof body.summary.guest_fees.count).toBe('number');
      expect(typeof body.summary.ball_purchases.count).toBe('number');
      expect(Array.isArray(body.transactions)).toBe(true);
    });

    it('transaction entries have expected fields when list is non-empty', async () => {
      const res = await get('get-transactions');
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      if (body.transactions.length > 0) {
        const t = body.transactions[0];
        expect(typeof t.id).toBe('string');
        expect(typeof t.date).toBe('string');
        expect(typeof t.time).toBe('string');
        expect(typeof t.type).toBe('string');
        expect(typeof t.amount_cents).toBe('number');
        expect(typeof t.amount_dollars).toBe('string');
      }
    });

    it('filters by transaction type', async () => {
      const res = await get('get-transactions', { type: 'ball_purchase' });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      for (const t of body.transactions) {
        expect(t.type).toBe('ball_purchase');
      }
    });

    it('accepts a date range filter and returns 200', async () => {
      const res = await get('get-transactions', {
        date_start: START_DATE,
        date_end: END_DATE,
        limit: '10',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.transactions)).toBe(true);
      expect(body.transactions.length).toBeLessThanOrEqual(10);
    });
  });

  // ─── get-session-history ─────────────────────────────────────────────────

  describe('get-session-history', () => {
    it('returns 200 with ok:true, count, and sessions array', async () => {
      const res = await get('get-session-history');

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.count).toBe('number');
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.count).toBe(body.sessions.length);
    });

    it('session entries have expected fields when list is non-empty', async () => {
      const res = await get('get-session-history');
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      if (body.sessions.length > 0) {
        const s = body.sessions[0];
        expect(typeof s.id).toBe('string');
        expect(typeof s.session_type).toBe('string');
        expect(typeof s.court_number).toBe('number');
        expect(Array.isArray(s.participants)).toBe(true);
      }
    });

    it('accepts date_start / date_end filters and returns 200', async () => {
      const res = await get('get-session-history', {
        date_start: START_DATE,
        date_end: END_DATE,
        limit: '20',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.sessions.length).toBeLessThanOrEqual(20);
    });

    it('returns 200 with empty or filtered list for a non-matching member_name', async () => {
      const res = await get('get-session-history', {
        member_name: 'ZZZZNONEXISTENT99999',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.count).toBe(0);
      expect(body.sessions).toHaveLength(0);
    });
  });

  // ─── get-frequent-partners ───────────────────────────────────────────────

  describe('get-frequent-partners', () => {
    it('returns 200 with ok:true and a partners array for a non-existent member', async () => {
      // Cache miss + live RPC returns empty for an unknown member — function returns ok:true
      const res = await post('get-frequent-partners', {
        member_id: '00000000-0000-0000-0000-000000000099',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.partners)).toBe(true);
    });

    it('returns HTTP 400 when member_id is missing', async () => {
      const res = await post('get-frequent-partners', {});

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/member_id is required/i);
    });
  });
});
