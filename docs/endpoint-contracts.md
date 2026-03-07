# Endpoint Contracts

Contract reference for the 5 critical Edge Function endpoints. Covers request shape, response shape, and consistency notes.

## Shared response envelope

Most endpoints use helpers from `_shared/response.ts`:

```
Success:  { ok: true,  serverNow, ...data }                — HTTP 200
Error:    { ok: false, code, message, serverNow }           — HTTP 400/404/409/500
```

`successResponse()` spreads data fields at the top level alongside `ok` and `serverNow`.
`errorResponse()`, `notFoundResponse()`, `conflictResponse()`, and `internalErrorResponse()` all return `ok`, `code`, `message`, `serverNow`.

CORS headers are added by each function (not by the shared helpers).

---

## get-board

**Purpose:** Read-only board state for the frontend.

**Method:** GET

**Request:** No body. No required fields.

**Success response:**
```
{ ok, serverNow, courts, waitlist, operatingHours, upcomingBlocks, settings }
```

**Error response:** Shared `internalErrorResponse` — `{ ok, code, message, serverNow }` at HTTP 500.

**Helpers:** Uses shared `successResponse`, `internalErrorResponse` from `_shared/index.ts`.

---

## assign-court

**Purpose:** Create a new court session for one or more participants.

**Method:** POST

**Request fields:**
- `court_id` (string, required)
- `session_type` (`'singles'` | `'doubles'`, required)
- `participants` (array, required) — each has `type`, `member_id` or `guest_name`, `account_id`
- `device_id` (string, required)
- `device_type` (string, required)
- `add_balls`, `split_balls` (boolean, optional)
- `latitude`, `longitude`, `accuracy` (number, optional — required for mobile devices)
- `location_token` (string, optional — QR alternative to GPS)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success response:**
```
{ ok, serverNow, session, displacement, timeLimitReason, isInheritedEndTime, inheritedFromScheduledEnd, board }
```
`session` contains `id`, `court_id`, `court_number`, `court_name`, `session_type`, `duration_minutes`, `started_at`, `scheduled_end_at`, `participants`.
`board` is the full board state (same shape as `get-board` success data) or `null` on fetch failure.

**Error responses:** Shared helpers — `errorResponse` (validation), `conflictResponse` (`MEMBER_ALREADY_PLAYING`, `MEMBER_ALREADY_ON_WAITLIST`), `internalErrorResponse` (catch).

**Helpers:** Uses shared `successResponse`, `errorResponse`, `conflictResponse`, `internalErrorResponse` from `_shared/index.ts`.

---

## end-session

**Purpose:** End one or more active sessions, by session ID or court ID.

**Method:** POST

**Request fields:**
- `session_id` (string, optional — provide this or `court_id`)
- `court_id` (string, optional — provide this or `session_id`; can be UUID or court number)
- `end_reason` (string, optional — normalized via `normalizeEndReason`)
- `device_id` (string, optional)

**Success response (by session_id):**
```
{ ok, serverNow, session, cacheOk, board }
```
`session` contains `id`, `courtId`, `startedAt`, `endedAt`, `sessionType`.

**Success response (by court_id):**
```
{ ok, serverNow, sessionsEnded, message, cacheOk, board }
```

**Error responses:** Shared helpers — `errorResponse` (validation), `notFoundResponse`, `conflictResponse` (`SESSION_ALREADY_ENDED`), `internalErrorResponse` (catch).

**Helpers:** Uses shared `successResponse`, `errorResponse`, `notFoundResponse`, `conflictResponse`, `internalErrorResponse` from `_shared/index.ts`. Uses `endSession`, `findAllActiveSessionsOnCourt`, `signalBoardChange` from `_shared/sessionLifecycle.ts`.

---

## join-waitlist

**Purpose:** Add a group to the waitlist.

**Method:** POST

**Request fields:**
- `group_type` (`'singles'` | `'doubles'`, required)
- `participants` (array, required) — same shape as assign-court
- `device_id` (string, required)
- `device_type` (string, required)
- `latitude`, `longitude` (number, optional — required for mobile devices)
- `deferred` (boolean, optional)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success response:**
```
{ ok, code: 'OK', message: '', serverNow, data: { waitlist: { id, group_type, position, status, joined_at, participants } } }
```

**Denial response:**
```
{ ok: false, code, message, serverNow, data: null }
```
Denial codes: `INVALID_GROUP_TYPE`, `NO_PARTICIPANTS`, `INVALID_PARTICIPANT_COUNT`, `INVALID_PARTICIPANT`, `MISSING_DEVICE_ID`, `DEVICE_NOT_REGISTERED`, `CLUB_CLOSED`, `OUTSIDE_HOURS`, `LOCATION_REQUIRED`, `GEOFENCE_FAILED`, `ALREADY_ON_WAITLIST`.

**Catch response:**
```
{ ok: false, code: 'INTERNAL_ERROR', message, serverNow, data: null }
```

**Consistency notes:**
- Uses **local** response helpers defined in the file, not the shared `_shared/response.ts` helpers.
- Success response wraps payload in a `data` key and includes `code: 'OK'` and `message: ''`. The shared `successResponse` spreads data at the top level and omits `code`/`message`.
- Denial and catch responses include an extra `data: null` key not present in the shared envelope.
- All denial responses return HTTP 200; the shared `errorResponse` defaults to HTTP 400.
- The local `internalErrorResponse` uses code `'INTERNAL_ERROR'` (uppercase); the shared version uses `'internal_error'` (lowercase).

---

## assign-from-waitlist

**Purpose:** Assign a waitlist entry to a court, creating a session.

**Method:** POST

**Request fields:**
- `waitlist_id` (string, required)
- `court_id` (string, required)
- `device_id` (string, required)
- `device_type` (string, required)
- `add_balls`, `split_balls` (boolean, optional)
- `latitude`, `longitude`, `accuracy` (number, optional — required for mobile devices)
- `location_token` (string, optional)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success response:**
```
{ ok, serverNow, session, waitlist, positions_updated, timeLimitReason, isInheritedEndTime, inheritedFromScheduledEnd, board }
```
`session` contains `id`, `court_id`, `court_number`, `court_name`, `session_type`, `duration_minutes`, `started_at`, `scheduled_end_at`, `participants`, `participantDetails`.
`waitlist` contains `id`, `previous_position`, `status`.

**Catch response:**
```
{ ok: false, serverNow, code: 'INTERNAL_ERROR', message }
```
HTTP 200. (Normalized in Step 9B from the previous `{ ok, serverNow, error }` shape.)

**Consistency notes:**
- Does **not** use shared response helpers. Success and error responses are built with inline `new Response(JSON.stringify(...))`.
- Success response spreads data at the top level (matches shared `successResponse` pattern structurally).
- Catch response now includes `code` and `message` (as of Step 9B), but returns HTTP 200 instead of the shared 500.
- All validation failures use `throw new Error(...)` and fall through to the single catch block. There are no early-return denial responses with specific codes.
- Overtime session ending bypasses the shared `endSession()` function and uses a raw `.update()` + `.insert()` instead.
