import { describe, it, expect } from 'vitest';
import {
  END_REASONS,
  WAITLIST_STATUSES,
  GROUP_TYPES,
  COURT_NUMBERS,
  isValidEndReason,
  isValidWaitlistStatus,
  isValidGroupType,
} from '../../../supabase/functions/_shared/constants.ts';

describe('constants', () => {
  describe('enum arrays', () => {
    it('END_REASONS contains expected values', () => {
      expect(END_REASONS).toEqual([
        'cleared',
        'observed_cleared',
        'admin_override',
        'overtime_takeover',
        'auto_cleared',
      ]);
    });

    it('WAITLIST_STATUSES contains expected values', () => {
      expect(WAITLIST_STATUSES).toEqual(['waiting', 'assigned', 'cancelled']);
    });

    it('GROUP_TYPES contains expected values', () => {
      expect(GROUP_TYPES).toEqual(['singles', 'doubles', 'foursome']);
    });

    it('COURT_NUMBERS contains 1-12', () => {
      expect(COURT_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });
  });

  describe('isValidEndReason', () => {
    it.each([
      'cleared',
      'observed_cleared',
      'admin_override',
      'overtime_takeover',
      'auto_cleared',
    ])('returns true for valid reason: %s', (reason) => {
      expect(isValidEndReason(reason)).toBe(true);
    });

    it('returns false for invalid string', () => {
      expect(isValidEndReason('invalid')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidEndReason('')).toBe(false);
    });

    it('returns false for number', () => {
      expect(isValidEndReason(42)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isValidEndReason(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isValidEndReason(undefined)).toBe(false);
    });

    it('returns false for case mismatch', () => {
      expect(isValidEndReason('Cleared')).toBe(false);
    });
  });

  describe('isValidWaitlistStatus', () => {
    it.each(['waiting', 'assigned', 'cancelled'])(
      'returns true for valid status: %s',
      (status) => {
        expect(isValidWaitlistStatus(status)).toBe(true);
      }
    );

    it('returns false for invalid string', () => {
      expect(isValidWaitlistStatus('pending')).toBe(false);
    });

    it('returns false for non-string', () => {
      expect(isValidWaitlistStatus(123)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isValidWaitlistStatus(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isValidWaitlistStatus(undefined)).toBe(false);
    });
  });

  describe('isValidGroupType', () => {
    it.each(['singles', 'doubles', 'foursome'])(
      'returns true for valid type: %s',
      (type) => {
        expect(isValidGroupType(type)).toBe(true);
      }
    );

    it('returns false for invalid string', () => {
      expect(isValidGroupType('triples')).toBe(false);
    });

    it('returns false for non-string', () => {
      expect(isValidGroupType(true)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isValidGroupType(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isValidGroupType(undefined)).toBe(false);
    });
  });
});
