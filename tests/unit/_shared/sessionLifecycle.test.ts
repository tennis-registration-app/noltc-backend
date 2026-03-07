import { describe, it, expect, vi } from 'vitest';
import { normalizeEndReason } from '../../../supabase/functions/_shared/sessionLifecycle.ts';

describe('normalizeEndReason', () => {
  describe('pass-through valid values', () => {
    it.each([
      'cleared',
      'observed_cleared',
      'admin_override',
      'overtime_takeover',
      'auto_cleared',
    ] as const)('passes through exact value: %s', (reason) => {
      expect(normalizeEndReason(reason)).toBe(reason);
    });
  });

  describe('undefined and empty', () => {
    it('returns cleared for undefined', () => {
      expect(normalizeEndReason(undefined)).toBe('cleared');
    });

    it('returns cleared for empty string', () => {
      expect(normalizeEndReason('')).toBe('cleared');
    });
  });

  describe('observed_cleared fuzzy matching', () => {
    it('matches "Observed-Cleared"', () => {
      expect(normalizeEndReason('Observed-Cleared')).toBe('observed_cleared');
    });

    it('matches "observed"', () => {
      expect(normalizeEndReason('observed')).toBe('observed_cleared');
    });

    it('matches "empty"', () => {
      expect(normalizeEndReason('empty')).toBe('observed_cleared');
    });

    it('matches "court observed empty"', () => {
      expect(normalizeEndReason('court observed empty')).toBe('observed_cleared');
    });
  });

  describe('cleared fuzzy matching', () => {
    it('matches "Cleared"', () => {
      expect(normalizeEndReason('Cleared')).toBe('cleared');
    });

    it('matches "clear"', () => {
      expect(normalizeEndReason('clear')).toBe('cleared');
    });

    it('matches "self-clear"', () => {
      expect(normalizeEndReason('self-clear')).toBe('cleared');
    });
  });

  describe('admin_override fuzzy matching', () => {
    it('matches "admin"', () => {
      expect(normalizeEndReason('admin')).toBe('admin_override');
    });

    it('matches "force"', () => {
      expect(normalizeEndReason('force')).toBe('admin_override');
    });

    it('"Admin Clear" matches cleared (clear check fires before admin check)', () => {
      expect(normalizeEndReason('Admin Clear')).toBe('cleared');
    });

    it('matches "force-end"', () => {
      expect(normalizeEndReason('force-end')).toBe('admin_override');
    });
  });

  describe('overtime_takeover fuzzy matching', () => {
    it('matches "bumped"', () => {
      expect(normalizeEndReason('bumped')).toBe('overtime_takeover');
    });

    it('matches "takeover"', () => {
      expect(normalizeEndReason('takeover')).toBe('overtime_takeover');
    });

    it('matches "overtime"', () => {
      expect(normalizeEndReason('overtime')).toBe('overtime_takeover');
    });
  });

  describe('auto_cleared fuzzy matching', () => {
    it('matches "completed"', () => {
      expect(normalizeEndReason('completed')).toBe('auto_cleared');
    });

    it('matches "timeout"', () => {
      expect(normalizeEndReason('timeout')).toBe('auto_cleared');
    });

    it('matches "time_expired"', () => {
      expect(normalizeEndReason('time_expired')).toBe('auto_cleared');
    });

    it('matches "expired"', () => {
      expect(normalizeEndReason('expired')).toBe('auto_cleared');
    });

    it('matches "auto"', () => {
      expect(normalizeEndReason('auto')).toBe('auto_cleared');
    });
  });

  describe('unknown values default to cleared', () => {
    it('returns cleared for unrecognized value', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(normalizeEndReason('xyz_unknown')).toBe('cleared');
      spy.mockRestore();
    });

    it('logs warning for unrecognized value', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      normalizeEndReason('something_weird');
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain('something_weird');
      spy.mockRestore();
    });
  });
});
