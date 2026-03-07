import { describe, it, expect, vi } from 'vitest';
import {
  normalizeEndReason,
  endSession,
  findActiveSessionOnCourt,
  findAllActiveSessionsOnCourt,
} from '../../../supabase/functions/_shared/sessionLifecycle.ts';

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

describe('endSession', () => {
  function mockSupabase(rpcResult: { data?: any; error?: any }) {
    return {
      rpc: vi.fn().mockResolvedValue({
        data: rpcResult.data ?? null,
        error: rpcResult.error ?? null,
      }),
    };
  }

  const BASE_OPTIONS = {
    sessionId: 'session-1',
    serverNow: '2024-01-01T00:00:00Z',
    endReason: 'cleared' as const,
  };

  it('returns error result when RPC call fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = mockSupabase({ error: { message: 'connection lost' } });
    const result = await endSession(sb, BASE_OPTIONS);
    expect(result).toEqual({
      success: false,
      alreadyEnded: false,
      error: 'connection lost',
    });
    spy.mockRestore();
  });

  it('returns alreadyEnded when RPC indicates session was already ended', async () => {
    const sb = mockSupabase({ data: { already_ended: true } });
    const result = await endSession(sb, BASE_OPTIONS);
    expect(result).toEqual({ success: false, alreadyEnded: true });
  });

  it('returns error when RPC returns success: false', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = mockSupabase({ data: { success: false, error: 'constraint violation' } });
    const result = await endSession(sb, BASE_OPTIONS);
    expect(result).toEqual({
      success: false,
      alreadyEnded: false,
      error: 'constraint violation',
    });
    spy.mockRestore();
  });

  it('returns success result on successful RPC', async () => {
    const sb = mockSupabase({ data: { success: true } });
    const result = await endSession(sb, BASE_OPTIONS);
    expect(result).toEqual({
      success: true,
      alreadyEnded: false,
      cacheOk: true,
    });
  });

  it('normalizes endReason before passing to RPC', async () => {
    const sb = mockSupabase({ data: { success: true } });
    await endSession(sb, { ...BASE_OPTIONS, endReason: 'admin' });
    expect(sb.rpc).toHaveBeenCalledWith('end_session_atomic', expect.objectContaining({
      p_end_reason: 'admin_override',
    }));
  });

  it('passes null for undefined deviceId', async () => {
    const sb = mockSupabase({ data: { success: true } });
    await endSession(sb, { ...BASE_OPTIONS, deviceId: undefined });
    expect(sb.rpc).toHaveBeenCalledWith('end_session_atomic', expect.objectContaining({
      p_device_id: null,
    }));
  });

  it('passes empty object for undefined eventData', async () => {
    const sb = mockSupabase({ data: { success: true } });
    await endSession(sb, { ...BASE_OPTIONS, eventData: undefined });
    expect(sb.rpc).toHaveBeenCalledWith('end_session_atomic', expect.objectContaining({
      p_event_data: {},
    }));
  });

  it('passes provided deviceId and eventData to RPC', async () => {
    const sb = mockSupabase({ data: { success: true } });
    await endSession(sb, {
      ...BASE_OPTIONS,
      deviceId: 'dev-1',
      eventData: { foo: 'bar' },
    });
    expect(sb.rpc).toHaveBeenCalledWith('end_session_atomic', expect.objectContaining({
      p_device_id: 'dev-1',
      p_event_data: { foo: 'bar' },
    }));
  });
});

describe('findActiveSessionOnCourt', () => {
  function mockSupabase(queryResult: { data?: any; error?: any }) {
    const terminal = {
      limit: vi.fn().mockResolvedValue({
        data: queryResult.data ?? null,
        error: queryResult.error ?? null,
      }),
    };
    const chain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue(terminal),
          }),
        }),
      }),
    };
    return { from: vi.fn().mockReturnValue(chain) };
  }

  it('returns session when found', async () => {
    const sb = mockSupabase({
      data: [{ id: 's-1', scheduled_end_at: '2024-01-01T01:00:00Z' }],
    });
    const result = await findActiveSessionOnCourt(sb, 'court-1');
    expect(result).toEqual({
      id: 's-1',
      scheduledEndAt: '2024-01-01T01:00:00Z',
    });
  });

  it('maps scheduled_end_at to camelCase scheduledEndAt', async () => {
    const sb = mockSupabase({
      data: [{ id: 's-2', scheduled_end_at: '2024-06-15T12:00:00Z' }],
    });
    const result = await findActiveSessionOnCourt(sb, 'court-1');
    expect(result).toHaveProperty('scheduledEndAt', '2024-06-15T12:00:00Z');
    expect(result).not.toHaveProperty('scheduled_end_at');
  });

  it('returns null when no sessions found', async () => {
    const sb = mockSupabase({ data: [] });
    const result = await findActiveSessionOnCourt(sb, 'court-1');
    expect(result).toBeNull();
  });

  it('returns null when data is null', async () => {
    const sb = mockSupabase({ data: null });
    const result = await findActiveSessionOnCourt(sb, 'court-1');
    expect(result).toBeNull();
  });

  it('returns null on query error', async () => {
    const sb = mockSupabase({ error: { message: 'query failed' } });
    const result = await findActiveSessionOnCourt(sb, 'court-1');
    expect(result).toBeNull();
  });
});

describe('findAllActiveSessionsOnCourt', () => {
  function mockSupabase(queryResult: { data?: any; error?: any }) {
    const terminal = {
      order: vi.fn().mockResolvedValue({
        data: queryResult.data ?? null,
        error: queryResult.error ?? null,
      }),
    };
    const chain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue(terminal),
        }),
      }),
    };
    return { from: vi.fn().mockReturnValue(chain) };
  }

  it('returns mapped sessions when found', async () => {
    const sb = mockSupabase({
      data: [
        { id: 's-1', scheduled_end_at: '2024-01-01T01:00:00Z' },
        { id: 's-2', scheduled_end_at: null },
      ],
    });
    const result = await findAllActiveSessionsOnCourt(sb, 'court-1');
    expect(result).toEqual([
      { id: 's-1', scheduledEndAt: '2024-01-01T01:00:00Z' },
      { id: 's-2', scheduledEndAt: null },
    ]);
  });

  it('returns empty array when no sessions found', async () => {
    const sb = mockSupabase({ data: [] });
    const result = await findAllActiveSessionsOnCourt(sb, 'court-1');
    expect(result).toEqual([]);
  });

  it('returns empty array when data is null', async () => {
    const sb = mockSupabase({ data: null });
    const result = await findAllActiveSessionsOnCourt(sb, 'court-1');
    expect(result).toEqual([]);
  });

  it('returns empty array on query error', async () => {
    const sb = mockSupabase({ error: { message: 'query failed' } });
    const result = await findAllActiveSessionsOnCourt(sb, 'court-1');
    expect(result).toEqual([]);
  });
});
