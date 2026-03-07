# NOLTC Backend

Supabase backend for the New Orleans Lawn Tennis Club Court Registration System.

## Overview

This repository contains:
- Database schema and migrations (`supabase/migrations/`)
- Edge Functions (`supabase/functions/`)
- Architecture documentation (`docs/`)

## Setup

1. Install Supabase CLI
2. Copy `.env.example` to `.env` and fill in credentials
3. Run `supabase link` to connect to the project
4. Run `supabase db push` to apply migrations

## Verification

Install dependencies, then run the quality gate:

```bash
npm install
npm run verify
```

`verify` runs three checks in sequence:

| Command | What it checks |
|---|---|
| `npm run lint` | ESLint (TypeScript rules) on `supabase/functions/_shared/` and `tests/` |
| `npm run typecheck` | `tsc --noEmit` on `_shared/` modules and test files |
| `npm run test` | Vitest unit tests in `tests/unit/` |

### Current scope

The verification gate intentionally covers only the **shared pure-function modules**:

- `_shared/constants.ts` — enum arrays and type guards
- `_shared/validate.ts` — input validation helpers
- `_shared/response.ts` — response envelope factories
- `_shared/participantKey.ts` — deterministic participant key generation
- `_shared/sessionLifecycle.ts` — `normalizeEndReason` only (no DB-dependent functions)

### What is NOT covered yet

- Individual Edge Function `index.ts` entrypoints (46 functions)
- Integration tests against a running Supabase instance
- Coverage reporting
- The `_shared/geofence.ts` module (has DB dependencies requiring mocks)
- DB-dependent functions in `_shared/sessionLifecycle.ts` (`endSession`, `signalBoardChange`, etc.)

### CI

GitHub Actions runs the same `lint → typecheck → test` sequence on every push and pull request to `main`. See `.github/workflows/verify.yml`.

### Expanding test scope

When adding tests for new modules:

1. Pure functions with no Supabase client dependency can be tested immediately — add a test file under `tests/unit/`.
2. Functions that accept a `supabase` client parameter can be tested by passing a mock object — no extraction needed.
3. Full Edge Function `index.ts` files require either refactoring to extract testable logic or integration tests against `supabase functions serve`.

## Related

- Frontend: https://github.com/tennis-registration-app/NOLTCsignup
