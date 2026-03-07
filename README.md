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

The verification gate covers the **shared pure-function modules** and their mock-based tests. It does **not** cover the 46 individual Edge Function `index.ts` entrypoints or integration tests against a running Supabase instance.

Covered modules:

- `_shared/constants.ts` — enum arrays and type guards
- `_shared/validate.ts` — input validation helpers
- `_shared/response.ts` — response envelope factories
- `_shared/participantKey.ts` — deterministic participant key generation
- `_shared/sessionLifecycle.ts` — `normalizeEndReason`, `endSession`, `findActiveSessionOnCourt`, `findAllActiveSessionsOnCourt`
- `_shared/geofence.ts` — `calculateDistance`, `validateLocationToken`

### What is NOT covered yet

- Individual Edge Function `index.ts` entrypoints (46 functions)
- Integration tests against a running Supabase instance
- Coverage reporting
- `validateGeofence` in `_shared/geofence.ts` (blocked by module-level `SKIP_GEOFENCE_CHECK` constant)

### CI

GitHub Actions runs the same `lint → typecheck → test` sequence on every push and pull request to `main`. See `.github/workflows/verify.yml`.

### Expanding test scope

When adding tests for new modules:

1. Pure functions with no Supabase client dependency can be tested immediately — add a test file under `tests/unit/`.
2. Functions that accept a `supabase` client parameter can be tested by passing a mock object — no extraction needed.
3. Full Edge Function `index.ts` files require either refactoring to extract testable logic or integration tests against `supabase functions serve`.

## Deployment

### Recommended deploy sequence

1. **Verify locally** — `npm run verify` must pass.
2. **Push database migrations** — `supabase db push`. Run this before deploying functions, because new functions may depend on new tables, columns, or RPCs added by migrations.
3. **Deploy Edge Functions** — `supabase functions deploy`. This deploys all functions. To deploy a single function: `supabase functions deploy <function-name>`.
4. **Validate post-deploy** — Run manual validation against the deployed environment (see Post-deploy validation below).

### Post-deploy validation

The `scripts/` directory contains manual test scripts that can be used to verify deployed functions. These scripts hit a live Supabase instance and should be run intentionally.

- `scripts/test-envelope-contracts.js` — Verifies that Edge Function responses conform to the `{ ok, serverNow, code, message }` envelope contract. Requires `SUPABASE_ANON_KEY` env var. Can target a specific URL via `SUPABASE_URL` env var.
- `scripts/test-assign-court.sh` — Sends sample assign-court requests. Contains hardcoded production URL and anon key.

See the warning comments at the top of each script for usage details.

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

## Manual test scripts

The `scripts/` directory contains manual test scripts. These are **not** part of the automated verification gate.

**Important:** Some scripts default to the production Supabase URL. Always review the target URL before running. See the warning comments at the top of each script.

| Script | Target | Auth required | Purpose |
|---|---|---|---|
| `test-assign-court.sh` | Production (hardcoded) | Hardcoded anon key | Sends sample assign-court requests |
| `test-envelope-contracts.js` | Production default, configurable via `SUPABASE_URL` | `SUPABASE_ANON_KEY` env var | Verifies response envelope shape |
| `test-envelope-contracts.ts` | Production default, configurable via `SUPABASE_URL` | `SUPABASE_ANON_KEY` env var | TypeScript version of envelope tests |

## Related

- Frontend: https://github.com/tennis-registration-app/NOLTCsignup
