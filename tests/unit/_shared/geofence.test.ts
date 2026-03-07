import { describe, it, expect, vi } from 'vitest';
import {
  calculateDistance,
  validateLocationToken,
} from '../../../supabase/functions/_shared/geofence.ts';

describe('calculateDistance', () => {
  it('returns 0 for identical coordinates', () => {
    expect(calculateDistance(0, 0, 0, 0)).toBe(0);
  });

  it('returns 0 for same non-zero coordinates', () => {
    expect(calculateDistance(29.95, -90.08, 29.95, -90.08)).toBe(0);
  });

  it('computes a known short distance correctly', () => {
    // ~111 km per degree of latitude at the equator
    const dist = calculateDistance(0, 0, 1, 0);
    expect(dist).toBeGreaterThan(110_000);
    expect(dist).toBeLessThan(112_000);
  });

  it('computes a known real-world distance', () => {
    // New Orleans (29.95, -90.07) to Baton Rouge (30.45, -91.19)
    // Approximately 130 km
    const dist = calculateDistance(29.95, -90.07, 30.45, -91.19);
    expect(dist).toBeGreaterThan(120_000);
    expect(dist).toBeLessThan(140_000);
  });

  it('is symmetric', () => {
    const ab = calculateDistance(29.95, -90.07, 30.45, -91.19);
    const ba = calculateDistance(30.45, -91.19, 29.95, -90.07);
    expect(ab).toBeCloseTo(ba, 6);
  });
});

describe('validateLocationToken', () => {
  // Helper to build a mock supabase client for location_tokens queries
  function mockSupabase(opts: {
    findData?: Record<string, unknown> | null;
    findError?: { message: string } | null;
    updateError?: { message: string } | null;
  }) {
    const updateResult = { error: opts.updateError ?? null };
    const findResult = { data: opts.findData ?? null, error: opts.findError ?? null };

    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(findResult),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            is: vi.fn().mockResolvedValue(updateResult),
          }),
        }),
      }),
    };
  }

  const VALID_TOKEN = 'A'.repeat(32);
  const MEMBER_ID = 'member-1';
  const DEVICE_ID = 'device-1';

  describe('format validation', () => {
    it('rejects empty token', async () => {
      const sb = mockSupabase({});
      const result = await validateLocationToken(sb, '', MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.message).toBe('Invalid token format');
    });

    it('rejects token shorter than 32 chars', async () => {
      const sb = mockSupabase({});
      const result = await validateLocationToken(sb, 'short', MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.message).toBe('Invalid token format');
    });

    it('rejects token longer than 32 chars', async () => {
      const sb = mockSupabase({});
      const result = await validateLocationToken(sb, 'A'.repeat(33), MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.message).toBe('Invalid token format');
    });
  });

  describe('token lookup', () => {
    it('returns not found when DB returns error', async () => {
      const sb = mockSupabase({ findError: { message: 'not found' } });
      const result = await validateLocationToken(sb, VALID_TOKEN, MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.message).toBe('Token not found');
    });

    it('returns not found when DB returns null data', async () => {
      const sb = mockSupabase({ findData: null });
      const result = await validateLocationToken(sb, VALID_TOKEN, MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.message).toBe('Token not found');
    });

    it('uppercases the token before querying', async () => {
      const lowerToken = 'a'.repeat(32);
      const sb = mockSupabase({ findData: null });
      await validateLocationToken(sb, lowerToken, MEMBER_ID, DEVICE_ID);

      const fromCall = sb.from.mock.results[0].value;
      const selectCall = fromCall.select.mock.results[0].value;
      const eqCall = selectCall.eq;
      expect(eqCall).toHaveBeenCalledWith('token', 'A'.repeat(32));
    });
  });

  describe('token state checks', () => {
    it('rejects already-used token', async () => {
      const sb = mockSupabase({
        findData: {
          id: 'tok-1',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          used_at: '2024-01-01T00:00:00Z',
        },
      });
      const result = await validateLocationToken(sb, VALID_TOKEN, MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.tokenId).toBe('tok-1');
      expect(result.message).toBe('Token has already been used');
    });

    it('rejects expired token', async () => {
      const sb = mockSupabase({
        findData: {
          id: 'tok-2',
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          used_at: null,
        },
      });
      const result = await validateLocationToken(sb, VALID_TOKEN, MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.tokenId).toBe('tok-2');
      expect(result.message).toBe('Token has expired');
    });
  });

  describe('token consumption', () => {
    it('returns failure when update errors (race condition guard)', async () => {
      const sb = mockSupabase({
        findData: {
          id: 'tok-3',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          used_at: null,
        },
        updateError: { message: 'conflict' },
      });
      const result = await validateLocationToken(sb, VALID_TOKEN, MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(false);
      expect(result.tokenId).toBe('tok-3');
      expect(result.message).toBe('Failed to validate token');
    });

    it('returns success for valid unused non-expired token', async () => {
      const sb = mockSupabase({
        findData: {
          id: 'tok-4',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          used_at: null,
        },
        updateError: null,
      });
      const result = await validateLocationToken(sb, VALID_TOKEN, MEMBER_ID, DEVICE_ID);
      expect(result.isValid).toBe(true);
      expect(result.tokenId).toBe('tok-4');
      expect(result.message).toBe('Location verified via token');
    });
  });
});
