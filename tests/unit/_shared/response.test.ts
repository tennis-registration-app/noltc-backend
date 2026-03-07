import { describe, it, expect } from 'vitest';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  conflictResponse,
  internalErrorResponse,
} from '../../../supabase/functions/_shared/response.ts';

async function parseBody(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text());
}

describe('response', () => {
  describe('successResponse', () => {
    it('returns status 200', () => {
      const res = successResponse({ count: 1 }, '2024-01-01T00:00:00Z');
      expect(res.status).toBe(200);
    });

    it('sets Content-Type header', () => {
      const res = successResponse({}, '2024-01-01T00:00:00Z');
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    it('body has ok: true', async () => {
      const body = await parseBody(successResponse({}, '2024-01-01T00:00:00Z'));
      expect(body.ok).toBe(true);
    });

    it('body includes serverNow', async () => {
      const body = await parseBody(successResponse({}, '2024-01-01T00:00:00Z'));
      expect(body.serverNow).toBe('2024-01-01T00:00:00Z');
    });

    it('body spreads data', async () => {
      const body = await parseBody(
        successResponse({ count: 5, items: [] }, '2024-01-01T00:00:00Z')
      );
      expect(body.count).toBe(5);
      expect(body.items).toEqual([]);
    });

    it('generates serverNow if not provided', async () => {
      const body = await parseBody(successResponse({}));
      expect(body.serverNow).toBeDefined();
      expect(typeof body.serverNow).toBe('string');
    });
  });

  describe('errorResponse', () => {
    it('returns specified status code', () => {
      const res = errorResponse('BAD_INPUT', 'bad', '2024-01-01T00:00:00Z', 422);
      expect(res.status).toBe(422);
    });

    it('defaults to status 400', () => {
      const res = errorResponse('BAD_INPUT', 'bad', '2024-01-01T00:00:00Z');
      expect(res.status).toBe(400);
    });

    it('sets Content-Type header', () => {
      const res = errorResponse('X', 'y');
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    it('body has ok: false', async () => {
      const body = await parseBody(errorResponse('X', 'y', '2024-01-01T00:00:00Z'));
      expect(body.ok).toBe(false);
    });

    it('body includes code and message', async () => {
      const body = await parseBody(
        errorResponse('BAD_INPUT', 'invalid field', '2024-01-01T00:00:00Z')
      );
      expect(body.code).toBe('BAD_INPUT');
      expect(body.message).toBe('invalid field');
    });

    it('body includes serverNow', async () => {
      const body = await parseBody(
        errorResponse('X', 'y', '2024-01-01T00:00:00Z')
      );
      expect(body.serverNow).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('notFoundResponse', () => {
    it('returns status 404', () => {
      const res = notFoundResponse('not found');
      expect(res.status).toBe(404);
    });

    it('body has code not_found', async () => {
      const body = await parseBody(notFoundResponse('missing', '2024-01-01T00:00:00Z'));
      expect(body.code).toBe('not_found');
    });

    it('body has ok: false', async () => {
      const body = await parseBody(notFoundResponse('missing'));
      expect(body.ok).toBe(false);
    });
  });

  describe('conflictResponse', () => {
    it('returns status 409', () => {
      const res = conflictResponse('DUPLICATE', 'already exists');
      expect(res.status).toBe(409);
    });

    it('body has the provided code', async () => {
      const body = await parseBody(
        conflictResponse('DUPLICATE', 'exists', '2024-01-01T00:00:00Z')
      );
      expect(body.code).toBe('DUPLICATE');
    });

    it('body has ok: false', async () => {
      const body = await parseBody(conflictResponse('X', 'y'));
      expect(body.ok).toBe(false);
    });
  });

  describe('internalErrorResponse', () => {
    it('returns status 500', () => {
      const res = internalErrorResponse('crash');
      expect(res.status).toBe(500);
    });

    it('body has code internal_error', async () => {
      const body = await parseBody(
        internalErrorResponse('boom', '2024-01-01T00:00:00Z')
      );
      expect(body.code).toBe('internal_error');
    });

    it('body has ok: false', async () => {
      const body = await parseBody(internalErrorResponse('oops'));
      expect(body.ok).toBe(false);
    });

    it('body includes message', async () => {
      const body = await parseBody(internalErrorResponse('db failed'));
      expect(body.message).toBe('db failed');
    });
  });
});
