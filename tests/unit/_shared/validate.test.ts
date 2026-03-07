import { describe, it, expect } from 'vitest';
import {
  requireString,
  requireUuid,
  requireEnum,
  requireArray,
  optionalString,
  isValidationError,
  requireEndReason,
  requireGroupType,
} from '../../../supabase/functions/_shared/validate.ts';

describe('validate', () => {
  describe('requireString', () => {
    it('returns the string when present and non-empty', () => {
      expect(requireString({ name: 'Alice' }, 'name')).toBe('Alice');
    });

    it('returns ValidationError for missing key', () => {
      const result = requireString({}, 'name');
      expect(isValidationError(result)).toBe(true);
      expect(result).toHaveProperty('field', 'name');
    });

    it('returns ValidationError for empty string', () => {
      const result = requireString({ name: '' }, 'name');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for whitespace-only string', () => {
      const result = requireString({ name: '   ' }, 'name');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for number value', () => {
      const result = requireString({ name: 42 }, 'name');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for null value', () => {
      const result = requireString({ name: null }, 'name');
      expect(isValidationError(result)).toBe(true);
    });
  });

  describe('requireUuid', () => {
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';

    it('returns UUID when valid lowercase', () => {
      expect(requireUuid({ id: validUuid }, 'id')).toBe(validUuid);
    });

    it('returns UUID when valid uppercase', () => {
      const upper = validUuid.toUpperCase();
      expect(requireUuid({ id: upper }, 'id')).toBe(upper);
    });

    it('returns ValidationError for missing key', () => {
      const result = requireUuid({}, 'id');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for non-string', () => {
      const result = requireUuid({ id: 123 }, 'id');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for invalid format', () => {
      const result = requireUuid({ id: 'not-a-uuid' }, 'id');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for UUID missing segment', () => {
      const result = requireUuid({ id: '550e8400-e29b-41d4-a716' }, 'id');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for empty string', () => {
      const result = requireUuid({ id: '' }, 'id');
      expect(isValidationError(result)).toBe(true);
    });
  });

  describe('requireEnum', () => {
    const allowed = ['a', 'b', 'c'] as const;

    it('returns value when it matches allowed', () => {
      expect(requireEnum({ val: 'a' }, 'val', allowed)).toBe('a');
    });

    it('returns ValidationError for value not in allowed', () => {
      const result = requireEnum({ val: 'd' }, 'val', allowed);
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for missing key', () => {
      const result = requireEnum({}, 'val', allowed);
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for non-string', () => {
      const result = requireEnum({ val: 1 }, 'val', allowed);
      expect(isValidationError(result)).toBe(true);
    });

    it('error message lists allowed values', () => {
      const result = requireEnum({ val: 'x' }, 'val', allowed);
      expect(isValidationError(result)).toBe(true);
      if (isValidationError(result)) {
        expect(result.message).toContain('a, b, c');
      }
    });
  });

  describe('requireArray', () => {
    it('returns array when present', () => {
      const arr = [1, 2, 3];
      expect(requireArray({ items: arr }, 'items')).toEqual(arr);
    });

    it('returns empty array when present and empty', () => {
      expect(requireArray({ items: [] }, 'items')).toEqual([]);
    });

    it('returns ValidationError for missing key', () => {
      const result = requireArray({}, 'items');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for string value', () => {
      const result = requireArray({ items: 'not-array' }, 'items');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for null', () => {
      const result = requireArray({ items: null }, 'items');
      expect(isValidationError(result)).toBe(true);
    });

    it('returns ValidationError for object', () => {
      const result = requireArray({ items: {} }, 'items');
      expect(isValidationError(result)).toBe(true);
    });
  });

  describe('optionalString', () => {
    it('returns value when string is present', () => {
      expect(optionalString({ name: 'Alice' }, 'name')).toBe('Alice');
    });

    it('returns default when key is missing', () => {
      expect(optionalString({}, 'name')).toBe('');
    });

    it('returns custom default when key is missing', () => {
      expect(optionalString({}, 'name', 'N/A')).toBe('N/A');
    });

    it('returns default when value is number', () => {
      expect(optionalString({ name: 42 }, 'name')).toBe('');
    });

    it('returns default when value is null', () => {
      expect(optionalString({ name: null }, 'name', 'fallback')).toBe('fallback');
    });

    it('returns empty string value (not default)', () => {
      expect(optionalString({ name: '' }, 'name', 'fallback')).toBe('');
    });
  });

  describe('isValidationError', () => {
    it('returns true for valid error shape', () => {
      expect(isValidationError({ field: 'x', message: 'bad' })).toBe(true);
    });

    it('returns false for string', () => {
      expect(isValidationError('error')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isValidationError(null)).toBe(false);
    });

    it('returns false for object missing field', () => {
      expect(isValidationError({ message: 'bad' })).toBe(false);
    });

    it('returns false for object missing message', () => {
      expect(isValidationError({ field: 'x' })).toBe(false);
    });

    it('returns true for object with extra properties', () => {
      expect(isValidationError({ field: 'x', message: 'y', extra: 1 })).toBe(true);
    });
  });

  describe('requireEndReason', () => {
    it('returns valid end reason', () => {
      expect(requireEndReason({ end_reason: 'cleared' })).toBe('cleared');
    });

    it('returns ValidationError for invalid reason', () => {
      const result = requireEndReason({ end_reason: 'nope' });
      expect(isValidationError(result)).toBe(true);
    });

    it('uses default key end_reason', () => {
      expect(requireEndReason({ end_reason: 'auto_cleared' })).toBe('auto_cleared');
    });

    it('accepts custom key', () => {
      expect(requireEndReason({ reason: 'cleared' }, 'reason')).toBe('cleared');
    });
  });

  describe('requireGroupType', () => {
    it('returns valid group type', () => {
      expect(requireGroupType({ group_type: 'singles' })).toBe('singles');
    });

    it('returns ValidationError for invalid type', () => {
      const result = requireGroupType({ group_type: 'triples' });
      expect(isValidationError(result)).toBe(true);
    });

    it('accepts custom key', () => {
      expect(requireGroupType({ type: 'doubles' }, 'type')).toBe('doubles');
    });
  });
});
