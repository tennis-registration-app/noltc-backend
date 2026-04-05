# Architecture — NOLTC Backend

This document answers "why is the backend structured this way?" for a new developer. For setup and verification commands, see [README.md](../README.md). For pre-production requirements and sharp edges, see [HANDOFF.md](../HANDOFF.md).

---

## System Role

The backend is the authority for all state mutations. The frontend (`NOLTCsignup/`) is a view layer: it reads board state via the `get-board` Edge Function and writes via HTTP calls to mutation functions. No state is held in the frontend beyond what was last returned by the backend.

This is a **single-tenant, single-club system**. It was designed for one private tennis club (~2,500 members, 12 courts). There is no multi-tenancy, no per-club configuration layer, and no expectation of horizontal scaling beyond what Supabase provides out of the box.

---

## Why Edge Functions, Not a REST API Framework

All 44 backend operations are implemented as Supabase Edge Functions — individual Deno/TypeScript functions deployed to Supabase's edge runtime, co-located with the database.

**Why this over a traditional REST API (Express, Fastify, etc.):**

- **Co-location.** Edge Functions run close to the database. There is no separate API server to deploy, maintain, or pay for.
- **Independent deployments.** Each function is its own deployment unit. Updating `assign-court` does not touch `end-session`. Rollback is per-function (`git checkout <commit> && supabase functions deploy <name>`).
- **Service role access.** Functions run with the Supabase service role key, which bypasses Row Level Security. This is necessary for server-side operations like ending sessions, updating member stats, and writing audit logs.
- **RLS still protects direct access.** The frontend uses the anon key for read-only `get-board` queries. RLS policies ensure a frontend client can never write directly to the database.

**Trade-off:** There is no shared middleware, no request router, and no dependency injection framework. Each function handles its own CORS headers, request parsing, input validation, and error responses. The `_shared/` module pattern compensates for this — see below.

---

## The `_shared/` Module Pattern

Shared helpers live in `supabase/functions/_shared/`. This directory uses the underscore prefix convention, which tells the Supabase CLI not to deploy it as a function.

**Barrel export:** `_shared/index.ts` re-exports the stable public surface of each shared module. New functions should import from `../\_shared/index.ts` rather than individual files, with one exception: `geofence.ts` is imported directly because its `SKIP_GEOFENCE_CHECK` flag is a pre-production concern that callers should be deliberate about touching.

**Current shared modules:**

| Module | Exports | Used by |
|--------|---------|---------|
| `constants.ts` | Enums, type guards | All functions |
| `response.ts` | `successResponse`, `errorResponse`, `conflictResponse`, `internalErrorResponse` | Mutation functions |
| `validate.ts` | `requireUuid`, `requireEnum`, `requireArray`, `requireString`, `isValidationError` | Mutation functions |
| `sessionLifecycle.ts` | `endSession`, `signalBoardChange`, `findActiveSessionOnCourt`, `normalizeEndReason` | assign-court, assign-from-waitlist, end-session |
| `participantKey.ts` | `generateParticipantKey` | assign-court, assign-from-waitlist |
| `deviceLookup.ts` | `verifyDevice` | assign-court, assign-from-waitlist |
| `boardFetch.ts` | `fetchBoardState` | assign-court, assign-from-waitlist |
| `geofenceCheck.ts` | `enforceGeofence` | assign-court, assign-from-waitlist |
| `courtAssignment.ts` | `lookupDuration`, `processGuestFees`, `processBallPurchase` | assign-court, assign-from-waitlist |
| `cors.ts` | `corsHeaders`, `addCorsHeaders` | All functions |

---

## Why Polling, Not Realtime

The frontend polls for board state updates on 30-second and 60-second intervals (visibility-aware — polling pauses when the browser tab is hidden). It does not use Supabase Realtime WebSocket subscriptions.

**Why polling was chosen:**
- The primary clients are iPad kiosks and wall-mounted displays in a club environment. WebSocket connections in these environments can be silently interrupted and do not reconnect reliably without additional handling.
- Polling is simpler to reason about, test, and debug. A missed poll is a temporary stale display; a dropped WebSocket subscription can produce permanently stale state with no visible error.
- For a club with 12 courts and low-frequency mutations, a 30-second update lag is acceptable.

A `board_change_signals` table exists in the schema and mutation functions call `signalBoardChange()` after every state change (`_shared/sessionLifecycle.ts`). This table is ready for a future Realtime subscription if polling proves insufficient, but the frontend does not currently subscribe to it.

---

## Why the Service Role Key in Edge Functions

Edge Functions receive the Supabase service role key via the `SUPABASE_SERVICE_ROLE_KEY` environment variable, which is set automatically by the Supabase runtime. This key bypasses all RLS policies, giving functions full read/write access to the database.

**This is intentional.** Functions perform operations that require crossing RLS boundaries:
- Ending a session updates `sessions`, inserts into `session_events`, and updates `members.uncleared_streak` — three tables that belong to different logical ownership domains
- Audit logging writes to `audit_log` on behalf of the requesting device, not the authenticated user
- Member streak updates require writing to `members` rows the requesting user does not own

**Identity model:** Callers are identified by `device_id` (a UUID registered in the `devices` table) and `device_type` (`kiosk`, `mobile`, `admin`). There is no user authentication token. This is an honor-system identity model appropriate for a private club where all devices are club-owned or member-owned. The `audit_log` table records every mutation with device ID, IP address, and outcome.

---

## Database Architecture

The database uses PostgreSQL with 9 stored procedures (RPC functions) for operations that require atomicity across multiple tables:

| Procedure | Purpose |
|-----------|---------|
| `end_session_atomic` | Ends a session, inserts END event, updates member streak — single transaction |
| `move_court_atomic` | Moves an active session to a new court — single transaction |
| `reorder_waitlist` | Renumbers waitlist positions after a removal |
| `get_court_board` | Returns full board state as a single RPC call |
| `get_active_waitlist` | Returns current waitlist |
| `get_upcoming_blocks` | Returns near-future court blocks |
| `search_session_history` | Member play history search |
| `get_frequent_partners` | Partner suggestion data |
| `refresh_frequent_partners` | Recalculates partner cache after session end |

Edge Functions call RPCs via `supabase.rpc()` for these operations. Direct table inserts and updates are used for simpler operations (session creation, audit logging, participant records) where atomicity across multiple tables is not required.

---

## Geofence Design

Mobile devices registering courts can be required to prove physical presence at the club. Two validation paths exist:

- **GPS path:** The mobile device submits `latitude`, `longitude`, and `accuracy`. The `validateGeofence()` function (`_shared/geofence.ts`) computes the Haversine distance between the device and the club coordinates stored in `system_settings` (`club_latitude`, `club_longitude`, `geofence_radius_meters`). Requests outside the radius are denied and logged to `audit_log`.

- **QR token path:** A location token is generated and encoded as a QR code displayed at the club. The mobile device scans it and submits the token. The `validateLocationToken()` function validates the token against the `location_tokens` table, checks expiry, and marks it used in a single update with a race-condition guard (`WHERE used_at IS NULL`).

Kiosk devices (`device_type = 'kiosk'`) skip geofence validation entirely — they are physically mounted at the club.

**Current status:** Geofence enforcement is disabled via `SKIP_GEOFENCE_CHECK = true` at `_shared/geofence.ts` line 4. This flag exists because geofence validation requires on-site testing with physical mobile devices — it cannot be validated in a development or CI environment. See [HANDOFF.md](../HANDOFF.md) for the go-live validation protocol.

---

## Migration Convention

All schema changes are applied as Supabase migrations in `supabase/migrations/`. Two constraints govern how migrations are written:

1. **One PL/pgSQL function per file.** The Supabase CLI statement splitter fails when a file contains multiple `$$...$$`-quoted function bodies. Each stored procedure must be in its own migration file.

2. **`LANGUAGE plpgsql` after the closing `$$`.** The CLI also fails when `LANGUAGE` appears before `AS $$`. The correct form is:
   ```sql
   CREATE OR REPLACE FUNCTION foo() RETURNS void AS $$
   BEGIN
     -- body
   END;
   $$ LANGUAGE plpgsql SECURITY DEFINER;
   ```

The baseline schema was split into 10 files (prefixed `00000000000000` through `00000000000009`) to comply with these constraints. Subsequent migrations use timestamp-based prefixes (`20260113000000_...`). See README.md → Known Issues for the full technical background.

---

## Testing Strategy

**Unit tests** (`tests/unit/`) test pure functions in `_shared/` with a mocked Supabase client. There are 169 tests across 6 modules. These run in milliseconds and are part of the PR gate (`npm run verify`).

**Integration tests** (`tests/integration/`) make real HTTP calls against the live deployed Edge Functions and verify both the HTTP response shape and resulting database state. There are 21 tests across 4 functions. Key conventions:

- All test fixtures use UUIDs in the `d0000000-*` namespace to avoid collisions with real data.
- Tests run sequentially (`fileParallelism: false` in `vitest.integration.config.ts`) to prevent shared-state contamination between tests.
- Two `assign-court` tests depend on the club being within operating hours (America/Chicago). They will return a time-related error outside business hours — this is correct behavior, not a test defect.
- Integration tests run nightly at 7 AM Central (within operating hours) and can be triggered manually.

---

## Resolved Architectural Debt

These items were identified during development and have since been resolved:

- **`join-waitlist` response envelope** — migrated to `_shared/response.ts` with proper HTTP 400/409 status codes. Integration tests updated to match.
- **Guest fee and ball purchase atomicity** — session creation, participant insertion, fee transactions, and waitlist update are now wrapped in the `create_session_with_fees` PostgreSQL RPC (single `SECURITY DEFINER` transaction). A failure at any step rolls back the entire operation.
- **Development-era logging** — debug `console.log` calls with emoji markers removed from all Edge Functions.
- **Endpoint documentation** — all 44 Edge Functions documented in `docs/endpoint-contracts.md` (method, auth, request/response shapes, error codes).
