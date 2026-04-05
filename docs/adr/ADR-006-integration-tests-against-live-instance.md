# ADR-006: Integration Tests Against Live Supabase Instance

## Status
Accepted

## Context

Edge Functions run in the Deno runtime and import dependencies via HTTPS URLs (`https://deno.land/...`, `https://esm.sh/...`). They cannot be imported as Node modules and therefore cannot be unit-tested with Vitest in the standard way. Options considered:

1. **Unit test with mocks** — mock the Supabase client and test function logic in isolation. High setup cost, doesn't test the actual HTTP handler or database behavior.
2. **`supabase functions serve` + local Supabase** — blocked by the `supabase start` CLI bug (see ADR-005); the local stack cannot be brought up reliably.
3. **HTTP integration tests against live deployed functions** — test the real deployed code path over HTTP, using a service role key for direct DB setup/teardown.

## Decision

Integration tests make real HTTP calls to the live production Supabase instance. Test fixtures use deterministic UUIDs in the `d0000000-*` namespace to avoid collisions with real member/session data. The Supabase JS client with the service role key is used for `beforeAll` setup and `afterEach` cleanup.

Key conventions:
- `fileParallelism: false` in `vitest.integration.config.ts` — tests run sequentially to prevent cross-test DB state contamination
- Tests are isolated from `npm run verify` — they run via `npm run test:integration` and require `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`
- A nightly GitHub Actions workflow (`.github/workflows/integration-tests.yml`) runs tests at 7 AM Central — within club operating hours, since two `assign-court` tests depend on the club being open

## Consequences

**Benefits:**
- Tests the real deployed code path including Deno runtime, RLS bypass, and database triggers
- Catches production regressions that unit tests with mocks would miss (demonstrated: discovered and fixed the `end_session_atomic` parameter-order bug via integration test failures)
- No complex mock setup to maintain

**Trade-offs:**
- Tests mutate the live production database — mitigated by the deterministic UUID namespace and `afterEach` cleanup
- Time-dependent: `assign-court` and `join-waitlist` happy-path tests fail outside club operating hours (America/Chicago); the nightly schedule accounts for this
- Requires valid credentials — cannot run in a cold fork without configuring repository secrets
