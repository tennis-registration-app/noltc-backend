import { describe, it, expect } from 'vitest';
import { checkOperatingHours } from '../../../supabase/functions/_shared/operatingHours.ts';

// All timestamps are chosen so that, when converted to America/Chicago (CDT = UTC-5 in June):
//   WITHIN_HOURS  : 2024-06-16T14:00:00Z → 9:00 AM Central  (opens 07:00, closes 21:00 → within)
//   BEFORE_OPENING: 2024-06-16T11:00:00Z → 6:00 AM Central  (before 07:00 → before opening)
//   AFTER_CLOSING : 2024-06-17T03:00:00Z → 10:00 PM Central (after 21:00 → after closing)
// 2024-06-16 is a Sunday (day_of_week = 0).

function makeMockClient({
  override = null as Record<string, unknown> | null,
  hoursData = { opens_at: '07:00:00', closes_at: '21:00:00', is_closed: false } as Record<string, unknown> | null,
  hoursError = null as unknown,
} = {}) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: unknown) => ({
          single: async () => {
            if (table === 'operating_hours_overrides') {
              return { data: override, error: override === null ? { code: 'PGRST116' } : null };
            }
            if (table === 'operating_hours') {
              return { data: hoursData, error: hoursError };
            }
            return { data: null, error: null };
          },
        }),
      }),
    }),
  };
}

describe('checkOperatingHours', () => {
  it('resolves when current time is within regular hours', async () => {
    const supabase = makeMockClient();
    await expect(checkOperatingHours(supabase, '2024-06-16T14:00:00.000Z')).resolves.toBeUndefined();
  });

  it('throws before opening time', async () => {
    const supabase = makeMockClient();
    await expect(checkOperatingHours(supabase, '2024-06-16T11:00:00.000Z')).rejects.toThrow(
      'Registration opens at 07:00'
    );
  });

  it('throws after closing time', async () => {
    const supabase = makeMockClient();
    await expect(checkOperatingHours(supabase, '2024-06-17T03:00:00.000Z')).rejects.toThrow(
      'Registration is closed for today (closed at 21:00)'
    );
  });

  it('throws when regular hours mark day as closed', async () => {
    const supabase = makeMockClient({
      hoursData: { opens_at: '07:00:00', closes_at: '21:00:00', is_closed: true },
    });
    await expect(checkOperatingHours(supabase, '2024-06-16T14:00:00.000Z')).rejects.toThrow(
      'The club is closed today'
    );
  });

  it('throws when override marks day as closed', async () => {
    const supabase = makeMockClient({
      override: { is_closed: true, opens_at: null, closes_at: null },
    });
    await expect(checkOperatingHours(supabase, '2024-06-16T14:00:00.000Z')).rejects.toThrow(
      'The club is closed today'
    );
  });

  it('uses override hours when present', async () => {
    // Override: opens 10:00, closes 16:00. Test at 8:00 AM Central (13:00 UTC) — before override opening.
    const supabase = makeMockClient({
      override: { is_closed: false, opens_at: '10:00:00', closes_at: '16:00:00' },
    });
    await expect(checkOperatingHours(supabase, '2024-06-16T13:00:00.000Z')).rejects.toThrow(
      'Registration opens at 10:00'
    );
  });
});
