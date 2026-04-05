/**
 * Integration tests for the ai-assistant Edge Function.
 *
 * Scope: validation and auth rejection paths only.
 * Full draft/execute mode tests are not included — they require the Anthropic API
 * to be configured and would make real LLM calls. The tests below exercise the
 * validation gates that fire before any AI call is made.
 *
 * Auth flow in the function:
 *   1. Validate prompt present              → throw → HTTP 200 ok:false
 *   2. Validate device_id present           → throw → HTTP 200 ok:false
 *   3. Check ANTHROPIC_API_KEY is set       → throw → HTTP 200 ok:false (if missing)
 *   4. Validate mode is read|draft|execute  → HTTP 400
 *   5. Execute mode: require actions_token  → HTTP 400
 *   6. Look up + verify device              → throw if not found/inactive
 *   7. Only admin devices allowed           → throw → HTTP 200 ok:false
 */
import { describe, it, expect } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const MISSING_ENV = !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY;

// Pre-seeded kiosk device — always present, not an admin device
const KIOSK_DEVICE_ID = 'a0000000-0000-0000-0000-000000000001';

async function callAiAssistant(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/ai-assistant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(MISSING_ENV)('ai-assistant Edge Function (integration)', () => {

  // ─── validation paths that don't require the AI ───────────────────────────

  it('returns HTTP 400 ok:false when prompt is missing', async () => {
    const res = await callAiAssistant({
      device_id: KIOSK_DEVICE_ID,
      mode: 'draft',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/prompt is required/i);
  });

  it('returns HTTP 400 ok:false when device_id is missing', async () => {
    const res = await callAiAssistant({
      prompt: 'What courts are available?',
      mode: 'draft',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/device_id is required/i);
  });

  it('returns HTTP 400 when mode is invalid', async () => {
    const res = await callAiAssistant({
      prompt: 'What courts are available?',
      device_id: KIOSK_DEVICE_ID,
      mode: 'invalid_mode',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/invalid mode/i);
  });

  it('returns HTTP 400 when execute mode is used without actions_token', async () => {
    const res = await callAiAssistant({
      prompt: 'Cancel the block on court 1',
      device_id: KIOSK_DEVICE_ID,
      mode: 'execute',
      // actions_token intentionally omitted
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/execute mode requires actions_token/i);
  });

  it('returns HTTP 400 ok:false when a non-admin (kiosk) device calls ai-assistant', async () => {
    // All throw-path errors from the catch block return HTTP 400.
    // Either "Only admin devices" (Anthropic key present) or
    // "Anthropic API key not configured" (key absent) will appear.
    const res = await callAiAssistant({
      prompt: 'What courts are available?',
      device_id: KIOSK_DEVICE_ID,
      mode: 'read',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    const isExpectedError =
      /admin devices/i.test(body.error) ||
      /anthropic api key/i.test(body.error);
    expect(isExpectedError).toBe(true);
  });
});
