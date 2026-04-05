/**
 * Integration tests for read-only blocks and waitlist endpoints:
 * - get-blocks  (POST, requires device_type:'admin' in request body)
 * - get-waitlist (GET, no auth)
 *
 * get-blocks auth note: the function checks requestData.device_type (the value
 * supplied in the JSON body) against 'admin' — it does NOT cross-check with the
 * device's actual device_type in the DB.  The kiosk device therefore passes the
 * auth gate when device_type:'admin' is sent in the body.
 */
import { describe, it, expect } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

// Pre-seeded kiosk device — always exists in the test environment
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';

function authHeaders(contentType = false) {
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

async function callGetBlocks(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/get-blocks`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
}

describe.skipIf(MISSING_ENV)('read endpoints — blocks / waitlist (integration)', () => {

  // ─── get-blocks ───────────────────────────────────────────────────────────

  describe('get-blocks', () => {
    it('returns 200 with ok:true and a blocks array for a valid admin request', async () => {
      const res = await callGetBlocks({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'admin', // get-blocks checks this body field, not the DB record
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(typeof body.serverNow).toBe('string');
      expect(Array.isArray(body.blocks)).toBe(true);
    });

    it('block entries have the expected camelCase fields', async () => {
      const res = await callGetBlocks({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'admin',
      });
      const body = await res.json() as any;

      expect(body.ok).toBe(true);
      // Only inspect entries if blocks exist — empty is also valid
      if (body.blocks.length > 0) {
        const b = body.blocks[0];
        expect(typeof b.id).toBe('string');
        expect(typeof b.courtId).toBe('string');
        expect(typeof b.courtNumber).toBe('number');
        expect(typeof b.blockType).toBe('string');
        expect(typeof b.title).toBe('string');
        expect(typeof b.startsAt).toBe('string');
        expect(typeof b.endsAt).toBe('string');
      }
    });

    it('accepts an explicit from_date and to_date range', async () => {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const res = await callGetBlocks({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'admin',
        from_date: from,
        to_date: to,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.blocks)).toBe(true);
    });

    it('returns HTTP 403 UNAUTHORIZED when device_type is not admin', async () => {
      const res = await callGetBlocks({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'kiosk', // actual type — not 'admin'
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(typeof body.serverNow).toBe('string');
    });

    it('returns HTTP 400 VALIDATION_ERROR when device_id is missing', async () => {
      const res = await callGetBlocks({
        device_type: 'admin',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns HTTP 400 VALIDATION_ERROR when to_date is before from_date', async () => {
      const from = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
      const to = new Date().toISOString(); // ends before starts

      const res = await callGetBlocks({
        device_id: KIOSK_DEVICE_ID,
        device_type: 'admin',
        from_date: from,
        to_date: to,
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── get-waitlist ─────────────────────────────────────────────────────────
  //
  // NOTE: get-waitlist reads from `active_waitlist_view`. This view is defined
  // in the baseline migration but has not been added to this Supabase project's
  // PostgREST schema cache. Until deployed, this function returns HTTP 400.
  //
  // The board state equivalent (get-board) calls get_active_waitlist() RPC
  // directly and works fine. get-waitlist is a separate admin read endpoint
  // that uses the view path.

  describe('get-waitlist', () => {
    it('returns HTTP 400 because active_waitlist_view is not deployed [view pending]', async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-waitlist`, {
        headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/active_waitlist_view/i);
    });

    it.todo('returns 200 with ok:true, count, and waitlist array [requires active_waitlist_view deployed]');
    it.todo('waitlist entries have id, position, group_type, joined_at, participants fields [requires view]');
  });
});
