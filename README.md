# NOLTC Backend

Supabase backend for the New Orleans Lawn Tennis Club Court Registration System.

## Overview

This repository contains:
- Database schema and migrations (`supabase/migrations/`)
- Edge Functions (`supabase/functions/`)
- Architecture documentation (`docs/`)

## Prerequisites

- Node.js >= 22 (see `.nvmrc`)
- Supabase CLI (`npm install` pulls it as a dev dependency)
- A linked Supabase project (or local Supabase for development)

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in credentials
3. Run `supabase link` to connect to the project
4. Run `supabase db push` to apply migrations

## Verification

Run the quality gate before every commit and deploy:

```bash
npm run verify
```

`verify` runs three checks in sequence:

| Command | What it checks |
|---|---|
| `npm run lint` | ESLint (TypeScript rules) on `supabase/functions/_shared/` and `tests/` |
| `npm run typecheck` | `tsc --noEmit` on `_shared/` modules and test files |
| `npm run test` | Vitest unit tests in `tests/unit/` |

Each check can also be run individually:

```bash
npm run lint
npm run typecheck
npm run test
```

### Current scope

The verification gate covers the **shared pure-function modules** and their mock-based tests. It does **not** cover the 46 individual Edge Function `index.ts` entrypoints.

Covered modules:

- `_shared/constants.ts` — enum arrays and type guards
- `_shared/validate.ts` — input validation helpers
- `_shared/response.ts` — response envelope factories
- `_shared/participantKey.ts` — deterministic participant key generation
- `_shared/sessionLifecycle.ts` — `normalizeEndReason`, `endSession`, `findActiveSessionOnCourt`, `findAllActiveSessionsOnCourt`
- `_shared/geofence.ts` — `calculateDistance`, `validateLocationToken`

### What is NOT covered by `npm run verify`

- Individual Edge Function `index.ts` entrypoints (46 functions)
- Coverage reporting
- `validateGeofence` in `_shared/geofence.ts` (blocked by module-level `SKIP_GEOFENCE_CHECK` constant)

### CI

GitHub Actions runs the same `lint → typecheck → test` sequence on every push and pull request to `main`. See `.github/workflows/verify.yml`.

### Expanding test scope

When adding tests for new modules:

1. Pure functions with no Supabase client dependency can be tested immediately — add a test file under `tests/unit/`.
2. Functions that accept a `supabase` client parameter can be tested by passing a mock object — no extraction needed.
3. Full Edge Function `index.ts` files require either refactoring to extract testable logic or integration tests against `supabase functions serve`.

## Integration tests

Integration tests run HTTP calls against the **live deployed Edge Functions** and verify end-to-end behavior including database state.

```bash
npm run test:integration
```

### Coverage

21 tests across 4 critical Edge Function entrypoints:

| Test file | Tests | Notes |
|---|---|---|
| `end-session` | 5 | Ends by session_id and court number; error cases for missing/invalid fields; 409 on double-end |
| `join-waitlist` | 5 | Singles and doubles happy paths; validation error cases |
| `assign-court` | 6 | Singles and doubles happy paths with DB verification; occupied court, blocked court, missing fields |
| `assign-from-waitlist` | 5 | Singles and doubles happy paths with DB verification; occupied court, missing waitlist entry, missing fields |

### Requirements

Integration tests require three environment variables:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API Keys (JWT format, starts with `eyJ...`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API Keys (JWT format, starts with `eyJ...`) |

Pass them inline or create a `.env` file from `.env.example`:

```bash
# Option 1 — inline
SUPABASE_URL=https://... SUPABASE_ANON_KEY=eyJ... SUPABASE_SERVICE_ROLE_KEY=eyJ... npm run test:integration

# Option 2 — .env file
cp .env.example .env   # fill in values
npm run test:integration
```

### Important notes

- Integration tests are **not** part of `npm run verify` and are **not** run by CI. They require live credentials and network access.
- Tests use deterministic UUIDs in the `d0000000-*` range for all test fixtures to avoid collisions with real data.
- `fileParallelism: false` is set in `vitest.integration.config.ts` — tests run sequentially to prevent cross-test database state contamination.
- Two test cases (assign-court happy paths) depend on the club being within operating hours (America/Chicago). They will return a time-related error if run outside business hours — this is expected behavior, not a test defect.

## Deployment

### Recommended deploy sequence

1. **Verify locally** — `npm run verify` must pass.
2. **Push database migrations** — `supabase db push`. Run this before deploying functions, because new functions may depend on new tables, columns, or RPCs added by migrations.
3. **Deploy Edge Functions** — `supabase functions deploy`. This deploys all functions. To deploy a single function: `supabase functions deploy <function-name>`.
4. **Validate post-deploy** — Run manual validation against the deployed environment (see Post-deploy validation below).

### Post-deploy validation

The `scripts/` directory contains manual test scripts that verify deployed functions against a live Supabase instance. All scripts read credentials from environment variables or a `.env` file — no credentials are hardcoded.

If a required variable is missing, each script prints a clear error message naming the missing variable and directing you to **Supabase Dashboard → Project Settings → API Keys**.

> **Note:** Edge Functions require JWT-format keys (starting with `eyJ...`). The newer `sb_publishable_` / `sb_secret_` key format does not work as Bearer tokens and will result in 401 errors.

| Script | Purpose |
|---|---|
| `test-assign-court.sh` | Sends sample assign-court requests; includes a `Continue? [y/N]` confirmation guard before touching production data |
| `test-envelope-contracts.js` | Verifies that Edge Function responses conform to the `{ ok, serverNow, code, message }` envelope contract |
| `test-envelope-contracts.ts` | TypeScript version of the envelope contract tests |

Run any script with credentials inline or via a `.env` file:

```bash
# Inline
SUPABASE_URL=https://... SUPABASE_ANON_KEY=eyJ... bash scripts/test-assign-court.sh

# Or via .env file
cp .env.example .env   # fill in values
node scripts/test-envelope-contracts.js
```

### Rollback

**Edge Functions:** Supabase Edge Functions are deployed by overwriting the previous version. To roll back a broken function deploy, check out the last known-good commit and redeploy:

```bash
git checkout <known-good-commit>
supabase functions deploy <function-name>
```

**Database migrations:** Supabase migrations are forward-only. To undo a schema change, write a corrective forward migration that reverses the change, then push it:

```bash
supabase migration new <descriptive-name>
# Edit the new migration file to reverse the problematic change
supabase db push
```

## Known issues

### `supabase db push` fails on `move_court_atomic` (CLI parser bug)

`supabase start` and `supabase db push` fail with `SQLSTATE 42601` ("cannot insert multiple commands into a prepared statement") due to `move_court_atomic` and other PL/pgSQL functions in the baseline migration. This is a known upstream bug in the Supabase CLI's prepared-statement parser and affects all tested CLI versions including 2.84.10.

**Impact:** Does not affect production. All functions are deployed and working. The workaround for applying new migrations that contain PL/pgSQL functions is to paste the SQL directly into the **Supabase Dashboard SQL Editor**.

**Permanent fix:** A contractor can resolve this by splitting `00000000000000_baseline.sql` into separate DDL files (table definitions first, then functions), so no single migration file mixes statement types.

### `join-waitlist` uses a non-standard response envelope

`join-waitlist` does not use the shared helpers from `_shared/response.ts`. It returns HTTP 200 for all responses including validation failures, using its own internal `denialResponse()` helper rather than `errorResponse()` / `internalErrorResponse()`. This deviation is documented in the integration test comments. The integration tests assert against the actual production wire format, not the shape implied by the shared helpers.

## Recent fixes

### 2026-04-04 — `assign-from-waitlist` overtime takeover now uses shared `endSession()` helper

**Problem:** When `assign-from-waitlist` displaced an overtime session, it manually updated `sessions.actual_end_at` and inserted a `session_events` row directly, bypassing the `end_session_atomic` RPC. This skipped the `uncleared_streak` increment on the displaced session's registrant.

**Fix:** Replaced the manual two-step update with a single `endSession()` call (from `_shared/sessionLifecycle.ts`), which routes through `end_session_atomic`. The operation is now atomic and consistent with `assign-court`'s overtime takeover path. Deployed 2026-04-04.

### 2026-04-03 — `end_session_atomic` double-end now returns 409 instead of 500

**Symptom:** Calling `end-session` on an already-ended session returned HTTP 500 instead of HTTP 409 `SESSION_ALREADY_ENDED`.

**Root cause:** The production `end_session_atomic` database function had an older signature with swapped parameter order (`p_server_now` before `p_device_id`). When the corrected version was applied via `CREATE OR REPLACE FUNCTION`, PostgreSQL created a second overload with a different signature rather than replacing the original, causing an ambiguous-function error on every double-end call.

**Fix:** Dropped the old overload (`DROP FUNCTION IF EXISTS public.end_session_atomic(uuid, text, timestamptz, uuid, jsonb)`), then applied the correct version. Migration: `20260403000000_fix_end_session_atomic_already_ended.sql`.

## Related

- Frontend: https://github.com/tennis-registration-app/NOLTCsignup
