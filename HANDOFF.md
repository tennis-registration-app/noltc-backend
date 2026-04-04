# NOLTC Backend — Developer Handoff

This document covers what a new developer needs to know before making changes to the backend. Read the README.md first for setup, test commands, and project overview.

---

## Pre-Production Checklist

These items must be resolved before the system goes live at the club. They are safe for local development and testing in their current state, but will cause problems or security gaps in production.

### 1. SKIP_GEOFENCE_CHECK — must be set to false before go-live

**File:** `supabase/functions/_shared/geofence.ts` line 4

```ts
const SKIP_GEOFENCE_CHECK = true;  // ← change to false before production
```

**What it does:** When `true`, `validateGeofence()` returns success unconditionally with the message "Location check skipped (development mode)". The actual GPS boundary check (enforcing that members are physically at the club) never runs. The QR + GPS dual-verification flow is silently bypassed.

**Impact:** Any member can register courts remotely. The entire mobile presence enforcement system is inactive.

**Fix:** Change `true` to `false`. Then verify end-to-end in staging: scan QR code on a mobile device, confirm GPS check fires, confirm registration is rejected from outside the club boundary.

---

### 2. AI_ACTIONS_SECRET — must be set in Supabase project secrets

**File:** `supabase/functions/ai-assistant/index.ts` line 87–88

The AI assistant endpoint uses a dedicated JWT secret (`AI_ACTIONS_SECRET`) to sign and verify action tokens. This secret must be set in Supabase project secrets before the AI assistant endpoint is enabled in production.

**What happens without it:** The secret defaults to an empty string. All action token verification will fail with a signature mismatch — requests are rejected. This is the safe default (fail-closed).

**How to set it:**
1. Generate a strong random secret: `openssl rand -base64 32`
2. Add to Supabase project: Dashboard → Settings → Edge Functions → Secrets → Add `AI_ACTIONS_SECRET`

**What not to do:** Do not set `AI_ACTIONS_SECRET` to the same value as `SUPABASE_SERVICE_ROLE_KEY`. The service role key bypasses all Row Level Security — it must not be used as an auth secret for an externally-callable endpoint.

---

### 3. Admin authentication — frontend responsibility

The admin panel (`/admin/`) is currently open-access (no password or session check). Authentication must be implemented before deployment. This is tracked in the frontend repo (`NOLTCsignup`) — see `src/admin/guards/adminAccessGuard.ts` and the `VITE_ADMIN_ACCESS_MODE` feature flag. The seam exists; it is not wired.

---

### 4. Real member data

The seed data files (`00000000000001_seed_data.sql`, `00000000000002_dev_test_data.sql`) contain placeholder member data. Before production, the actual club member roster (member numbers, display names, account IDs) must be imported into the `accounts` and `members` tables. The seed data should be excluded from the production migration run, or cleared after migration.

---

## Sharp Edges for New Developers

### assign-court/index.ts (830 lines) — highest-risk backend file

`supabase/functions/assign-court/index.ts` is the most consequential Edge Function. It handles:
- Operating hours enforcement
- Geofence / location token verification
- Court availability check (active sessions, active blocks)
- Overtime takeover (ending an existing session to assign a new one)
- Waitlist assignment
- Direct court assignment
- Board signal emission
- Audit logging

It has integration tests (`tests/integration/assign-court.integration.test.ts`). **Do not modify this file without running the integration test suite.** The function is a candidate for decomposition — a roadmap comment exists inside the file.

---

### 42 of 46 Edge Functions have zero automated tests

The following functions have integration or unit test coverage:
- `assign-court` — 6 integration tests
- `assign-from-waitlist` — 5 integration tests
- `end-session` — 5 integration tests
- `join-waitlist` — 5 integration tests

All other Edge Functions (including `get-board`, `move-court`, `create-block`, `cancel-block`, `mark-wet-courts`, `purchase-balls`, `export-transactions`, all admin functions, and 32 others) have **zero automated test coverage**.

**Protocol for changes to untested functions:**
1. Read the function fully before touching it
2. Write an integration test that exercises the happy path and at least one error path before making changes
3. Run the full test suite after changes: `deno test --allow-all tests/`

This is not optional — untested functions have no regression protection.

---

### _shared/ module pattern

Shared logic lives in `supabase/functions/_shared/`:

| Module | Purpose |
|--------|---------|
| `response.ts` | HTTP response helpers (`successResponse`, `errorResponse`, `conflictResponse`, `internalErrorResponse`) |
| `validate.ts` | Input validation (`requireString`, `requireUuid`, `requireEnum`, `requireArray`) |
| `geofence.ts` | GPS and location token validation |
| `sessionLifecycle.ts` | `endSession()`, `signalBoardChange()`, active session queries |
| `participantKey.ts` | Deterministic participant key generation |
| `constants.ts` | Shared enums and constants |

**Note:** `sessionLifecycle.ts` is not re-exported from `_shared/index.ts`. Import it directly: `import { endSession } from "../_shared/sessionLifecycle.ts"`.

Use the shared helpers consistently. `assign-court` does its own inline validation rather than using `validate.ts` — this is a known inconsistency, not the intended pattern for new functions.

---

### Console logging volume

Edge Functions contain approximately 74 `console.log` and 80 `console.error` calls, many with development-era emoji markers (`🔍`, `⚠️`) and raw timing data. These appear in Supabase function logs. For a club system this is low risk, but it creates noise when diagnosing real errors. Clean up development-era logging before scaling or adding monitoring.

---

### join-waitlist response envelope

`join-waitlist` does not use the shared `response.ts` helpers. It returns HTTP 200 for all responses including validation failures, using an internal `denialResponse()` helper. This deviation is intentional and documented in the integration test comments. The integration tests assert against the actual production wire format.

---

## Integration Test Requirements

Tests require a live local Supabase instance:

```bash
npx supabase start       # start local DB + Edge Functions
deno test --allow-all tests/integration/  # run integration tests
npx supabase stop        # stop when done
```

Environment variables required for integration tests:
- `SUPABASE_URL` — local instance URL (default: `http://127.0.0.1:54321`)
- `SUPABASE_ANON_KEY` — local anon key (from `supabase status`)
- `SUPABASE_SERVICE_ROLE_KEY` — local service role key (from `supabase status`)

See `README.md` for full setup instructions.
