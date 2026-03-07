import { describe, it, expect } from 'vitest';
import { generateParticipantKey } from '../../../supabase/functions/_shared/participantKey.ts';

describe('generateParticipantKey', () => {
  describe('member participants', () => {
    it('generates key for single member using type field', () => {
      const result = generateParticipantKey([
        { type: 'member', member_id: 'aaa' },
      ]);
      expect(result).toBe('m:aaa');
    });

    it('generates key for single member using participant_type field', () => {
      const result = generateParticipantKey([
        { participant_type: 'member', member_id: 'bbb' },
      ]);
      expect(result).toBe('m:bbb');
    });

    it('accepts player as member type', () => {
      const result = generateParticipantKey([
        { type: 'player', member_id: 'ccc' },
      ]);
      expect(result).toBe('m:ccc');
    });
  });

  describe('guest participants', () => {
    it('generates key for single guest', () => {
      const result = generateParticipantKey([
        { type: 'guest', guest_name: 'Jane Doe' },
      ]);
      expect(result).toBe('g:jane doe');
    });

    it('normalizes guest name to lowercase', () => {
      const result = generateParticipantKey([
        { type: 'guest', guest_name: 'JOHN SMITH' },
      ]);
      expect(result).toBe('g:john smith');
    });

    it('trims whitespace from guest name', () => {
      const result = generateParticipantKey([
        { type: 'guest', guest_name: '  Alice  ' },
      ]);
      expect(result).toBe('g:alice');
    });

    it('collapses multiple spaces in guest name', () => {
      const result = generateParticipantKey([
        { type: 'guest', guest_name: 'Bob   Lee' },
      ]);
      expect(result).toBe('g:bob lee');
    });

    it('treats participant with no member_id as guest when guest_name exists', () => {
      const result = generateParticipantKey([
        { type: 'other', guest_name: 'Visitor' },
      ]);
      expect(result).toBe('g:visitor');
    });
  });

  describe('mixed participants', () => {
    it('combines members and guests with | separator', () => {
      const result = generateParticipantKey([
        { type: 'member', member_id: 'id-1' },
        { type: 'guest', guest_name: 'Guest One' },
      ]);
      expect(result).toContain('m:id-1');
      expect(result).toContain('g:guest one');
      expect(result).toContain('|');
    });

    it('sorts keys alphabetically for stable ordering', () => {
      const forward = generateParticipantKey([
        { type: 'member', member_id: 'zzz' },
        { type: 'member', member_id: 'aaa' },
      ]);
      const reversed = generateParticipantKey([
        { type: 'member', member_id: 'aaa' },
        { type: 'member', member_id: 'zzz' },
      ]);
      expect(forward).toBe(reversed);
      expect(forward).toBe('m:aaa|m:zzz');
    });

    it('sorts guest keys before member keys when g < m', () => {
      const result = generateParticipantKey([
        { type: 'member', member_id: 'id-1' },
        { type: 'guest', guest_name: 'Alice' },
      ]);
      expect(result).toBe('g:alice|m:id-1');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty array', () => {
      expect(generateParticipantKey([])).toBe('');
    });

    it('skips member with null member_id', () => {
      const result = generateParticipantKey([
        { type: 'member', member_id: null },
      ]);
      expect(result).toBe('');
    });

    it('skips guest with null guest_name', () => {
      const result = generateParticipantKey([
        { type: 'guest', guest_name: null },
      ]);
      expect(result).toBe('');
    });

    it('handles doubles group (4 participants)', () => {
      const result = generateParticipantKey([
        { type: 'member', member_id: 'd' },
        { type: 'member', member_id: 'b' },
        { type: 'member', member_id: 'c' },
        { type: 'member', member_id: 'a' },
      ]);
      expect(result).toBe('m:a|m:b|m:c|m:d');
    });
  });
});
