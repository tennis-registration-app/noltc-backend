# Start Here — NOLTC Backend

> Single entry point for the NOLTC backend. If you're new to this repo, read this first.

**Contractor/new maintainer?** See [HANDOFF.md](HANDOFF.md) for the pre-production checklist, sharp edges, and operational protocol. See [README.md](README.md) for full setup instructions, verification commands, and known issues.

## What This System Is

Supabase backend for the New Orleans Lawn Tennis Club Court Registration System — 12 courts, ~2,500 members. All mutations and queries are handled by Deno/TypeScript Edge Functions. The database is PostgreSQL with Row Level Security, 9 stored procedures, and Realtime publications.

The frontend lives in a separate repo (`NOLTCsignup/`). This repo contains only the backend: database schema, Edge Functions, migrations, and tests.

## Quick Start

**Prerequisites:** Node.js 22+, Supabase CLI (installed via `npm install`), Docker Desktop (required for local Supabase instance).

```bash
git clone <repository-url>
cd noltc-backend
npm install
cp .env.example .env       # Fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

**Verification gate — run before every commit:**

```bash
npm run verify
```

`npm run verify` runs lint + typecheck + unit tests. CI runs this on every push and pull request to `main`, followed by integration tests when repository secrets are available.

**For complete system verification (requires Supabase credentials):**

```bash
npm run validate:all
```

`validate:all` chains `verify` (lint + typecheck + 175 unit tests) with `test:integration` (160 integration tests + response shape contract tests) in one command. Integration and contract tests skip gracefully when env vars are missing (`describe.skipIf`).

- **Lint** covers all 41 Edge Function entrypoints plus `_shared/` and `tests/`.
- **Typecheck** covers `_shared/` and `tests/` only — Edge Function entrypoints import via HTTPS URLs (`https://deno.land/...`) which are unresolvable by Node-mode `tsc`. This is a known limitation, not a gap in practice.
- **Unit tests** cover `_shared/` modules (169 tests).

**Integration tests** (require live Supabase credentials):

```bash
npm run test:integration
```

Runs 160 integration tests across 19 test files against the live deployed Edge Functions. Also runs on every PR via CI when repository secrets are available — fork PRs skip this step. A separate nightly run fires at 7 AM Central as a post-deploy confidence check.

**Local development** (requires Docker Desktop):

```bash
npx supabase start          # Start local DB + Edge Functions (takes ~60s first time)
npx supabase stop           # Stop when done
```

## Repository Structure

```
supabase/
  functions/
    _shared/        # Shared helpers imported by Edge Functions
    assign-court/   # Session creation (most complex function — see HANDOFF.md)
    end-session/
    join-waitlist/
    assign-from-waitlist/
    ... (41 functions total)
  migrations/       # Database schema and seed data (28 files)

tests/
  unit/             # Unit tests for _shared/ modules (169 tests)
  integration/      # Integration tests for critical mutation flows (160 tests, 19 files)

scripts/            # Post-deploy validation scripts
docs/               # Schema, RLS, endpoint contracts
```

**Migration convention:** One PL/pgSQL function per migration file (Supabase CLI limitation). The `LANGUAGE plpgsql` clause must come *after* the closing `$$`, not before `AS $$`. See README.md → Known Issues for the full explanation.

## Verification Gates

| Gate | Command | When it runs |
|------|---------|-------------|
| Lint + typecheck + unit tests | `npm run verify` | Every PR (CI), before every commit |
| Integration tests + contract tests | `npm run test:integration` | Every PR (when secrets available); nightly at 7 AM Central; manual trigger |
| Complete system verification | `npm run validate:all` | Before releases; installer/setup validation |
| Post-deploy validation | `node scripts/test-envelope-contracts.js` | After each production deploy |

**Scope of `npm run verify`:** Lint covers all 41 Edge Function entrypoints plus `_shared/` and `tests/`. Typecheck and unit tests cover `_shared/` only (Deno HTTPS imports are incompatible with Node-mode `tsc` — see README.md for details).

## Key Documentation

| Document | What it covers |
|----------|---------------|
| [README.md](README.md) | Setup, verification commands, deployment, known issues, recent fixes |
| [HANDOFF.md](HANDOFF.md) | Pre-production checklist, sharp edges, integration test requirements |
| [docs/schema.md](docs/schema.md) | Full database schema reference |
| [docs/rls.md](docs/rls.md) | Row Level Security policies |
| [docs/endpoint-contracts.md](docs/endpoint-contracts.md) | API contracts for all 41 Edge Functions |

## Pre-Production Checklist

The following must be resolved before the system goes live at the club. All are safe for local development and testing in their current state. See [HANDOFF.md](HANDOFF.md) for the full details on each item.

1. **SKIP_GEOFENCE_CHECK → false** — Geofence enforcement is currently disabled. Change the flag in `supabase/functions/_shared/geofence.ts` line 4, then complete the on-site validation protocol documented in HANDOFF.md.

2. **AI_ACTIONS_SECRET** — Must be set as a Supabase project secret before the AI assistant endpoint is enabled. See HANDOFF.md § 2.

3. **Admin authentication** — The admin panel is currently open-access (no password). The auth seam exists in the frontend (`adminAccessGuard.ts`) but is not wired. Must be implemented before deployment. See HANDOFF.md § 3.

4. **Real member data** — The seed files contain placeholder members. The actual club roster must be imported before go-live. The dev seed files (`_001`, `_002`) should be excluded from the production migration run. See HANDOFF.md § 4.

## Test Coverage

19 integration test files covering key Edge Functions (160 tests total). Untested functions have no regression protection — before modifying one, follow the protocol in HANDOFF.md: read the function fully → write a test covering the happy path and at least one error path → make the change → run the full suite.
