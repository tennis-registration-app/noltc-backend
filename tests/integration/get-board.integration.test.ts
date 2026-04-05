import { describe, it, expect } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

async function callGetBoard(): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/get-board`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
}

describe.skipIf(MISSING_ENV)('get-board Edge Function (integration)', () => {
  it('returns 200 with the board envelope on a plain GET', async () => {
    const res = await callGetBoard();

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('string');
  });

  it('response includes courts, waitlist, operatingHours, and upcomingBlocks arrays', async () => {
    const res = await callGetBoard();
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(Array.isArray(body.courts)).toBe(true);
    expect(Array.isArray(body.waitlist)).toBe(true);
    expect(Array.isArray(body.operatingHours)).toBe(true);
    expect(Array.isArray(body.upcomingBlocks)).toBe(true);
  });

  it('returns the same shape for a POST request (function accepts any method)', async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/get-board`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.courts)).toBe(true);
  });

  it('courts array entries have expected fields', async () => {
    const res = await callGetBoard();
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(body.courts.length).toBeGreaterThan(0);

    const court = body.courts[0];
    expect(typeof court.court_number).toBe('number');
    // The RPC returns at least a court identifier — court_id or id
    const hasId = 'court_id' in court || 'id' in court;
    expect(hasId).toBe(true);
  });
});
