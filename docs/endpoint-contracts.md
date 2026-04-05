# Endpoint Contracts

Contract reference for all 44 Edge Functions. Covers method, auth, request/response shapes, and HTTP status notes.

---

## Shared response envelopes

Two patterns coexist across the codebase:

**`_shared` helpers** (`_shared/response.ts`) — used by most functions:
```
Success:  { ok: true,  serverNow, ...data }          HTTP 200
Error:    { ok: false, code, message, serverNow }     HTTP 400 (default) / 401 / 403 / 404 / 409 / 500
```

**Local helpers** — used by `cancel-block`, `create-block`, `update-block`, `get-settings`:
```
Success:  { ok: true,  code: 'OK', message: '', serverNow, data: {...}, board? }  HTTP 200
Denial:   { ok: false, code, message, serverNow, data: null }                     HTTP 200 (!)
Forbidden:{ ok: false, code: 'UNAUTHORIZED', message, serverNow, data: null }    HTTP 403
Internal: { ok: false, code: 'INTERNAL_ERROR', message, serverNow, data: null }  HTTP 500
```

**Throw-to-catch** — used by `cancel-waitlist`, `defer-waitlist`, `purchase-balls`, `restore-session`, `undo-overtime-takeover`, `update-session-tournament`:
```
Success:  { ok: true,  serverNow, ...data }          HTTP 200
Catch:    { ok: false, serverNow, error: message }   HTTP 200 (!)
```
(Some also have an explicit HTTP 403 return for auth failures before the catch.)

CORS headers (`Access-Control-Allow-Origin: *`) are added by each function independently, not by the shared helpers.

---

## 1. Board & Court Status

### get-board

**Purpose:** Full board state for the frontend — courts, waitlist, blocks, settings, hours.

**Method:** GET

**Auth:** None

**Request:** No body.

**Success (HTTP 200):**
```
{ ok, serverNow, courts, waitlist, operatingHours, upcomingBlocks, settings }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `internal_error` | 500 | Any DB failure |

**Helpers:** `_shared` — `successResponse`, `internalErrorResponse`.

---

### get-court-status

**Purpose:** Lightweight per-court availability snapshot.

**Method:** GET

**Auth:** None

**Request:** No body. Reads from `court_availability_view` and `active_sessions_view`.

**Success (HTTP 200):**
```
{ ok: true, timestamp, courts: [{ court_id, court_number, court_name, status,
  session?: { id, type, started_at, scheduled_end_at, minutes_remaining, participants[] },
  block?: { id, type, title, ends_at } }] }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```

---

### get-waitlist

**Purpose:** Current waitlist entries.

**Method:** GET

**Auth:** None

**Request:** No body. Reads from `active_waitlist_view`.

**Success (HTTP 200):**
```
{ ok: true, timestamp, count, waitlist: [{ id, position, group_type, joined_at, minutes_waiting, participants[] }] }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```

---

## 2. Session Management

### assign-court

**Purpose:** Start a new court session for one or more participants.

**Method:** POST

**Auth:** Any registered device. Mobile requires geofence or location token.

**Request fields:**
- `court_id` (string, required) — UUID
- `session_type` (`'singles'` | `'doubles'`, required)
- `participants` (array, required) — each: `{ type, member_id?, guest_name?, account_id, charged_to_account_id? }`
- `device_id` (string, required)
- `device_type` (string, required)
- `add_balls` (boolean, optional)
- `split_balls` (boolean, optional)
- `latitude`, `longitude`, `accuracy` (number, optional — required for mobile)
- `location_token` (string, optional — QR alternative to GPS)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok, serverNow, session, displacement, timeLimitReason, isInheritedEndTime,
  inheritedFromScheduledEnd, board }
```
`session`: `{ id, court_id, court_number, court_name, session_type, duration_minutes, started_at, scheduled_end_at, participants[] }`
`displacement`: `{ displacedSessionId, displacedCourtId, takeoverSessionId, restoreUntil, participants[] }` or `null`
`board`: full board state (same shape as `get-board` data) or `null` on failure

**Errors (all via throw → catch → `internalErrorResponse`):**
All validation failures, device not found, court occupied, hours closed, geofence failure throw and return `{ ok: false, code: 'internal_error', message, serverNow }` HTTP 500 — except:

| Code | HTTP | When |
|------|------|------|
| `MEMBER_ALREADY_PLAYING` | 409 | Member has active session |
| `MEMBER_ALREADY_ON_WAITLIST` | 409 | Member is on waitlist |
| `internal_error` | 500 | Catch-all |

**Helpers:** `_shared` — `successResponse`, `conflictResponse`, `internalErrorResponse`, `addCorsHeaders`.

---

### end-session

**Purpose:** End one or more active sessions by session ID or court ID.

**Method:** POST

**Auth:** None (device_id optional).

**Request fields:**
- `session_id` (string, optional) — provide this or `court_id`
- `court_id` (string, optional) — UUID or court number (1–12)
- `end_reason` (string, optional — default `'cleared'`)
- `device_id` (string, optional)

**Success by `session_id` (HTTP 200):**
```
{ ok, serverNow, session: { id, courtId, startedAt, endedAt, sessionType }, cacheOk, board }
```

**Success by `court_id` (HTTP 200):**
```
{ ok, serverNow, sessionsEnded, message, cacheOk, board }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `MISSING_IDENTIFIER` | 400 | Neither session_id nor court_id provided |
| `INVALID_END_REASON` | 400 | Invalid end_reason value |
| `INVALID_COURT_ID` | 400 | Non-UUID, non-numeric court_id |
| `not_found` | 404 | Court not found or no active session on court |
| `SESSION_ALREADY_ENDED` | 409 | Session already ended (session_id path only) |
| `internal_error` | 500 | DB failure |

**Helpers:** `_shared` — `successResponse`, `errorResponse`, `notFoundResponse`, `conflictResponse`, `internalErrorResponse`.

---

### admin-end-session

**Purpose:** Admin-only session end with optional reason field.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `session_id` (string, optional) — provide this or `court_id`
- `court_id` (string, optional)
- `reason` (string, optional)

**Success (HTTP 200):**
```
{ ok, serverNow, session: { id, courtId, endedAt }, board }
```
Special case: if no active session found on a court, returns `{ ok: true, ... }` at HTTP 200 (no error).

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `MISSING_DEVICE` | 400 | No device_id |
| `MISSING_IDENTIFIER` | 400 | Neither session_id nor court_id |
| `INVALID_DEVICE` | 401 | Device not found |
| `DEVICE_INACTIVE` | 401 | Device is_active = false |
| `UNAUTHORIZED` | 403 | Not admin device |
| `SESSION_NOT_FOUND` | 404 | session_id not found |
| `SESSION_ALREADY_ENDED` | 409 | Already ended |
| `INTERNAL_ERROR` | 500 | DB failure |

**Notes:** Uses inline response helpers (not `_shared`).

---

### admin-update-session

**Purpose:** Admin-only update of session participants and/or scheduled end time.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `session_id` (string, required)
- `participants` (array, required) — resolved by member_id or display_name lookup
- `scheduled_end_at` (ISO string, optional)

**Success (HTTP 200):**
```
{ ok, serverNow, session: { id, courtId, scheduledEndAt, participants[] } }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `MISSING_DEVICE` | 400 | No device_id |
| `MISSING_SESSION` | 400 | No session_id |
| `MISSING_PARTICIPANTS` | 400 | No participants |
| `SESSION_ENDED` | 400 | Session already ended |
| `NO_MEMBER_FOR_GUESTS` | 400 | Guest with no resolvable account |
| `INVALID_DEVICE` | 401 | Device not found |
| `DEVICE_INACTIVE` | 401 | Device is_active = false |
| `UNAUTHORIZED` | 403 | Not admin device |
| `SESSION_NOT_FOUND` | 404 | session_id not found |
| `INTERNAL_ERROR` | 500 | DB failure |

**Notes:** Uses inline response helpers (not `_shared`).

---

### move-court

**Purpose:** Atomically move an active session from one court to another.

**Method:** POST

**Auth:** Admin or kiosk device.

**Request fields:**
- `device_id` (string, required)
- `from_court_id` (string, required) — UUID or court number
- `to_court_id` (string, required) — UUID or court number

**Success (HTTP 200):**
```
{ ok, serverNow, message, sessionId, fromCourtId, toCourtId, board }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `BAD_REQUEST` | 400 | Missing from/to court |
| `SAME_COURT` | 400 | from and to are the same |
| `MISSING_FROM_COURT` | 400 | from_court_id missing |
| `MISSING_TO_COURT` | 400 | to_court_id missing |
| `UNAUTHORIZED` | 403 | Not admin or kiosk |
| `not_found` | 404 | Court not found or no active session on source |
| `DESTINATION_OCCUPIED` | 409 | Target court has active session |
| `DESTINATION_BLOCKED` | 409 | Target court has active block |
| `internal_error` | 500 | DB failure |

**Helpers:** `_shared` — `successResponse`, `errorResponse`, `conflictResponse`, `notFoundResponse`, `internalErrorResponse` (with local `addCorsHeaders`).

---

### clear-all-courts

**Purpose:** Admin action to end all active sessions on all courts.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `reason` (string, optional — default `'admin_clear'`)

**Success (HTTP 200):**
```
{ ok: true, message, sessionsEnded, serverNow, board }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `MISSING_DEVICE` | 400 | No device_id |
| `INVALID_DEVICE` | 401 | Device not found |
| `DEVICE_INACTIVE` | 401 | Device inactive |
| `UNAUTHORIZED` | 403 | Not admin |
| `INTERNAL_ERROR` | 500 | DB failure |

---

### auto-clear-sessions

**Purpose:** Scheduled job — ends sessions that have exceeded `auto_clear_minutes` from `system_settings`.

**Method:** POST (invoked by cron scheduler)

**Auth:** None.

**Request:** No body.

**Success (HTTP 200):**
```
{ ok, serverNow, cleared, total?, message, results?: [{ sessionId, courtNumber, success, error? }] }
```
Returns `{ cleared: 0, message: 'Auto-clear is disabled' }` when setting is off.

**Errors:**
```
{ ok: false, code: 'internal_error', message, serverNow }  HTTP 500
```

**Helpers:** `_shared` — `successResponse`, `internalErrorResponse` (with local `addCorsHeaders`).

---

### cleanup-sessions

**Purpose:** Admin utility to fix orphaned sessions (have END event but `actual_end_at` is null) and end duplicate active sessions per court.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)

**Success (HTTP 200):**
```
{ ok: true, message, sessionsChecked, endEventsFound, orphanedFound,
  orphanedFixed, fixErrors?, duplicatesEnded, endedIds[] }
```

**Errors:**
```
{ ok: false, code: 'MISSING_DEVICE_ID' }  HTTP 400
{ ok: false, code: 'DEVICE_NOT_FOUND' }   HTTP 400
{ ok: false, code: 'UNAUTHORIZED' }       HTTP 403
{ ok: false, error: message }             HTTP 500
```

**Notes:** Uses inline response helpers (not `_shared`).

---

### update-session-tournament

**Purpose:** Toggle the `is_tournament` flag on an active session.

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `session_id` (string, required)
- `is_tournament` (boolean, required)
- `device_id` (string, required)
- `device_type` (string, optional)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, session: { id, court_id, is_tournament } }
```

**Errors (throw-to-catch):**
```
{ ok: false, serverNow, error: message }  HTTP 200
```
Throws on: missing fields, device not found/inactive, session not found, session already ended.

---

### restore-session

**Purpose:** Restore a session that was ended by overtime takeover (kiosk users who changed courts).

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `displaced_session_id` (string, required)
- `takeover_session_id` (string, required)
- `device_id` (string, required)
- `device_type` (string, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, restoredSessionId }
```

**Conflict responses (all HTTP 200):**
```
{ ok: false, code: 'RESTORE_CONFLICT', message, serverNow }
```
Returned for: session not found, session still active, no END event, not ended by overtime takeover, court currently occupied.

**Catch errors (throw-to-catch, HTTP 200):**
```
{ ok: false, serverNow, error: message }
```

---

### undo-overtime-takeover

**Purpose:** Atomically reverses an overtime takeover — ends the takeover session and restores the displaced session.

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `takeover_session_id` (string, required)
- `displaced_session_id` (string, required)
- `device_id` (string, required)
- `device_type` (string, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, endedSessionId, restoredSessionId }
```

**Conflict responses (all HTTP 200):**
```
{ ok: false, code: 'UNDO_CONFLICT', message, serverNow }
```
Returned for: takeover session not found/already ended, displaced session not found/still active, sessions on different courts, no END event, not an overtime takeover, takeover ID mismatch, unexpected court state.

**Catch errors (throw-to-catch, HTTP 200):**
```
{ ok: false, serverNow, error: message }
```

---

## 3. Waitlist Management

### join-waitlist

**Purpose:** Add a group to the waitlist. Enforces operating hours and geofence for mobile.

**Method:** POST

**Auth:** Any registered device. Mobile requires geofence.

**Request fields:**
- `group_type` (`'singles'` | `'doubles'`, required)
- `participants` (array, required) — same shape as `assign-court`
- `device_id` (string, required)
- `device_type` (string, required)
- `latitude`, `longitude` (number, optional — required for mobile)
- `deferred` (boolean, optional)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok, serverNow, data: { waitlist: { id, group_type, position, status, joined_at, participants[] } } }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `INVALID_GROUP_TYPE` | 400 | Not 'singles' or 'doubles' |
| `NO_PARTICIPANTS` | 400 | Empty or missing participants |
| `MISSING_DEVICE_ID` | 400 | No device_id |
| `INVALID_PARTICIPANT_COUNT` | 400 | Wrong count for group type |
| `INVALID_PARTICIPANT` | 400 | Missing member_id, guest_name, or account_id |
| `CLUB_CLOSED` | 400 | Club closed today (override or regular hours) |
| `OUTSIDE_HOURS` | 400 | Before open or after close time |
| `DEVICE_NOT_REGISTERED` | 400 | device_id not in devices table |
| `LOCATION_REQUIRED` | 400 | Mobile device with no coordinates |
| `GEOFENCE_FAILED` | 400 | Coordinates outside geofence |
| `ALREADY_ON_WAITLIST` | 409 | One or more members already waiting |
| `internal_error` | 500 | Operating hours failure or DB error |

**Helpers:** `_shared` — `successResponse`, `errorResponse`, `conflictResponse`, `internalErrorResponse`, `addCorsHeaders`.

---

### assign-from-waitlist

**Purpose:** Assign a waitlist entry to a court, creating a session. Handles overtime takeover if applicable.

**Method:** POST

**Auth:** Any registered device. Mobile requires geofence or location token.

**Request fields:**
- `waitlist_id` (string, required)
- `court_id` (string, required) — UUID
- `device_id` (string, required)
- `device_type` (string, required)
- `add_balls`, `split_balls` (boolean, optional)
- `latitude`, `longitude`, `accuracy` (number, optional — required for mobile)
- `location_token` (string, optional)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, session, waitlist, positions_updated,
  timeLimitReason, isInheritedEndTime, inheritedFromScheduledEnd, board }
```
`session`: `{ id, court_id, court_number, court_name, session_type, duration_minutes, started_at, scheduled_end_at, participants[], participantDetails[] }`
`waitlist`: `{ id, previous_position, status: 'assigned' }`

**Catch errors (throw-to-catch, HTTP 200):**
```
{ ok: false, serverNow, code: 'INTERNAL_ERROR', message }
```

**Notes:** All validation failures throw and reach the single catch block. Throws on: missing fields, device issues, waitlist entry not found/not waiting, court not found/inactive/occupied/blocked, court 8 singles-only restriction. Geofence failures throw an error via `enforceGeofence`.

---

### cancel-waitlist

**Purpose:** Cancel a waiting entry (self-service or admin).

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `waitlist_id` (string, required)
- `device_id` (string, required)
- `device_type` (string, required)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, waitlist: { id, group_type, previous_position, status: 'cancelled', participants[] },
  positions_updated }
```

**Catch errors (throw-to-catch, HTTP 200):**
```
{ ok: false, serverNow, error: message }
```
Throws on: missing fields, device not found, entry not found, status is not 'waiting'.

---

### clear-waitlist

**Purpose:** Cancel all waiting entries (admin or kiosk action).

**Method:** POST

**Auth:** Admin or kiosk device.

**Request fields:**
- `device_id` (string, required)

**Success (HTTP 200):**
```
{ ok, serverNow, message, cancelledCount }
```
Returns `cancelledCount: 0` with `message: 'Waitlist is already empty'` when nothing to cancel.

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `BAD_REQUEST` | 400 | No device_id |
| `UNAUTHORIZED` | 403 | Unknown device, inactive device, or not admin/kiosk |
| `internal_error` | 500 | DB failure |

**Helpers:** `_shared` — `successResponse`, `errorResponse`, `internalErrorResponse` (with local `addCorsHeaders`).

---

### defer-waitlist

**Purpose:** Toggle the `deferred` flag on a waiting entry.

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `waitlist_id` (string, required)
- `deferred` (boolean, required)
- `device_id` (string, required)
- `device_type` (string, required)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, waitlist: { id, group_type, position, deferred } }
```

**Catch errors (throw-to-catch, HTTP 200):**
```
{ ok: false, serverNow, error: message }
```
Throws on: missing fields, device not found, entry not found, status not 'waiting'.

---

### remove-from-waitlist

**Purpose:** Admin action to remove a specific entry from the waitlist.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `waitlist_entry_id` (string, required)
- `reason` (string, optional)

**Success (HTTP 200):**
```
{ ok, serverNow, message: 'Removed from waitlist', waitlistEntryId, board }
```
`board` is the full board state or `null` on failure.

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `MISSING_DEVICE` | 400 | No device_id |
| `MISSING_WAITLIST_ENTRY` | 400 | No waitlist_entry_id |
| `INVALID_DEVICE` | 401 | Device not found |
| `DEVICE_INACTIVE` | 401 | Device inactive |
| `UNAUTHORIZED` | 403 | Not admin |
| `not_found` | 404 | Entry not found |
| `ENTRY_NOT_ACTIVE` | 409 | Entry not in 'waiting' status |
| `internal_error` | 500 | DB failure (catch) |

**Helpers:** `_shared` — `successResponse`, `errorResponse`, `notFoundResponse`, `conflictResponse`, `internalErrorResponse` (with local `addCorsHeaders`).

---

### reorder-waitlist

**Purpose:** Admin action to move a waitlist entry to a new position.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `entry_id` (string, required)
- `new_position` (integer ≥ 1, required)

**Success (HTTP 200):**
```
{ ok: true, old_position, new_position, serverNow, board }
```
`board` is the full board state or `null` on failure.

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `{ ok: false, error }` | 400 | Missing device_id, entry_id, or invalid new_position |
| `{ ok: false, error: 'Invalid device' }` | 401 | Device not found |
| `{ ok: false, error: 'Admin access required' }` | 403 | Not admin |
| `{ ok: false, error: rpc_message }` | 400 | RPC `reorder_waitlist` returned success=false |
| `{ ok: false, error: rpc_message }` | 500 | RPC threw an error |

**Notes:** Uses inline `new Response(...)` (not `_shared` helpers). Delegates to `reorder_waitlist` RPC for atomic repositioning.

---

## 4. Block Management

### create-block

**Purpose:** Create a court block (lesson, clinic, maintenance, etc.).

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `court_id` (string, required)
- `block_type` (`'lesson'` | `'clinic'` | `'maintenance'` | `'wet'` | `'other'`, required)
- `title` (string, required)
- `starts_at` (ISO datetime, required)
- `ends_at` (ISO datetime, required)
- `device_id` (string, required)
- `device_type` (string, required)
- `is_recurring` (boolean, optional)
- `recurrence_rule` (string, optional — required if `is_recurring`)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, code: 'OK', message: '', serverNow,
  data: { block: { id, court_id, court_number, court_name, block_type, title,
                   starts_at, ends_at, duration_minutes, is_recurring, recurrence_rule } },
  board }
```

**Denial responses (HTTP 200):**
`MISSING_COURT_ID`, `INVALID_BLOCK_TYPE`, `MISSING_TITLE`, `MISSING_STARTS_AT`, `MISSING_ENDS_AT`, `MISSING_DEVICE_ID`, `INVALID_STARTS_AT`, `INVALID_ENDS_AT`, `INVALID_DATE_RANGE`, `MISSING_RECURRENCE_RULE`, `DEVICE_NOT_REGISTERED`, `COURT_NOT_FOUND`, `OVERLAPPING_BLOCK`

**Auth failure (HTTP 403):** `UNAUTHORIZED`

**Internal error (HTTP 500):** `INTERNAL_ERROR`

**Notes:** Uses local response helpers. All denials return HTTP 200 (not 400).

---

### cancel-block

**Purpose:** Soft-cancel a court block.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `block_id` (string, required)
- `device_id` (string, required)
- `device_type` (string, required)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, code: 'OK', message: '', serverNow,
  data: { block: { id, court_id, court_number, court_name, block_type, title,
                   starts_at, ends_at, cancelled_at } },
  board }
```

**Denial responses (HTTP 200):**
`MISSING_BLOCK_ID`, `MISSING_DEVICE_ID`, `DEVICE_NOT_REGISTERED`, `BLOCK_NOT_FOUND`, `ALREADY_CANCELLED`

**Auth failure (HTTP 403):** `UNAUTHORIZED`

**Internal error (HTTP 500):** `INTERNAL_ERROR`

**Notes:** Uses local response helpers. All denials return HTTP 200.

---

### update-block

**Purpose:** Edit an existing non-past, non-cancelled block.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `block_id` (string, required)
- `device_id` (string, required)
- `device_type` (string, required)
- `court_id` (string, optional)
- `block_type` (string, optional)
- `title` (string, optional)
- `starts_at` (ISO datetime, optional)
- `ends_at` (ISO datetime, optional)
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, code: 'OK', message: '', serverNow,
  data: { block: { id, court_id, court_number, court_name, block_type, title,
                   starts_at, ends_at, duration_minutes, is_recurring, recurrence_rule } } }
```

**Denial responses (HTTP 200):**
`MISSING_BLOCK_ID`, `MISSING_DEVICE_ID`, `INVALID_BLOCK_TYPE`, `DEVICE_NOT_REGISTERED`, `BLOCK_NOT_FOUND`, `BLOCK_CANCELLED`, `BLOCK_IN_PAST`, `CANNOT_CHANGE_WET_TYPE`, `INVALID_DATE_RANGE`, `COURT_NOT_FOUND`, `NO_CHANGES`

**Auth failure (HTTP 403):** `UNAUTHORIZED`

**Internal error (HTTP 500):** `INTERNAL_ERROR`

**Notes:** Uses local response helpers. Cannot change `block_type` of a wet block. Cannot edit blocks whose `ends_at` is in the past.

---

### get-blocks

**Purpose:** List court blocks for a date range (admin only).

**Method:** POST

**Auth:** Admin device (checked from request body `device_type`, not DB lookup).

**Request fields:**
- `device_id` (string, required)
- `device_type` (`'admin'`, required)
- `court_id` (string, optional — filter by court)
- `from_date` (ISO datetime, optional — default: now)
- `to_date` (ISO datetime, optional — default: now + 90 days; max range 366 days)

**Success (HTTP 200):**
```
{ ok: true, serverNow, blocks: [{ id, courtId, courtNumber, blockType, title,
  startsAt, endsAt, isRecurring, recurrenceRule, createdAt }] }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `VALIDATION_ERROR` | 400 | Missing device_id/device_type or date range > 366 days |
| `DEVICE_NOT_FOUND` | 401 | device_id not in devices table |
| `UNAUTHORIZED` | 403 | device_type not 'admin' |
| `QUERY_ERROR` | 500 | DB query failure |
| `INTERNAL_ERROR` | 500 | Catch-all |

---

## 5. Wet Courts

### mark-wet-courts

**Purpose:** Admin action to create wet blocks on all or specific courts.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `duration_minutes` (integer, optional — default 720)
- `court_ids` (string[], optional — omit for all courts)
- `reason` (string, optional — default `'WET COURT'`)
- `idempotency_key` (string, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, courts_marked, court_numbers[], blocks_created,
  blocks_cancelled, ends_at, duration_minutes }
```
Idempotent hit: `{ ok: true, idempotent: true }` HTTP 200.

**Errors:**
```
{ ok: false, code: 'UNAUTHORIZED', message, serverNow }  HTTP 403
{ ok: false, serverNow, error: message }                  HTTP 200  (catch)
```

---

### clear-wet-courts

**Purpose:** Admin action to cancel active wet blocks on all or specific courts.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `court_ids` (string[], optional — omit for all courts)
- `idempotency_key` (string, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, blocks_cleared, court_numbers[] }
```

**Errors:**
```
{ ok: false, code: 'UNAUTHORIZED', message, serverNow }  HTTP 403
{ ok: false, serverNow, error: message }                  HTTP 200  (catch)
```

---

## 6. Analytics & Reporting

### get-analytics

**Purpose:** Summary analytics, heatmaps, and waitlist stats.

**Method:** POST

**Auth:** None.

**Request fields:**
- `start` (YYYY-MM-DD, optional — default: 7 days ago)
- `end` (YYYY-MM-DD, optional — default: today)

**Success (HTTP 200):**
```
{ ok: true, serverNow, range: { start, end },
  summary: { sessions, courtHoursUsed, ..., previous: {...} },
  heatmap: [{ dow, hour, count }],
  waitlist: [{ id, groupType, joinedAt, assignedAt, minutesWaited, playerNames }],
  waitlistHeatmap: [{ dow, hour, count, avgWait }] }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```

---

### get-usage-analytics

**Purpose:** Court usage heatmap by day-of-week and hour.

**Method:** POST

**Auth:** None.

**Request fields:**
- `days` (integer, optional — default 90, clamped 7–365)

**Success (HTTP 200):**
```
{ ok: true, heatmap: [...], daysAnalyzed, serverNow }
```

**Errors:**
```
{ ok: false, error: message, serverNow }  HTTP 400
```

---

### get-usage-comparison

**Purpose:** Compare a metric (usage or wait time) across two date ranges.

**Method:** POST

**Auth:** None.

**Request fields:**
- `metric` (`'usage'` | `'waittime'`, required)
- `primaryStart` (ISO datetime, required)
- `primaryEnd` (ISO datetime, required)
- `granularity` (`'auto'` | `'day'` | `'week'` | `'month'`, required)
- `comparisonStart` (ISO datetime, optional)

**Success (HTTP 200):**
```
{ ok: true, metric, unit, granularity,
  primary: { startDate, endDate, buckets: [{ bucketStart, bucketEnd, label, labelFull, value }] },
  comparison: null | { startDate, endDate, buckets: [...] } }
```

**Errors:**
```
{ error: message }  HTTP 400 or 500
```
**Note:** Error shape has no `ok` field.

---

### get-session-history

**Purpose:** Filtered session history for reporting.

**Method:** GET

**Auth:** None.

**Query params (all optional):**
- `member_name`, `date_start`, `date_end`, `court_number`, `limit` (default 100)

**Success (HTTP 200):**
```
{ ok: true, count, sessions: [{ id, date, started_at, ended_at, session_type,
  duration_minutes, end_reason, court_number, court_name: null,
  participants: [{ name, type, member_number }] }] }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 500
```

---

### get-frequent-partners

**Purpose:** Return cached frequent-partner data for a member.

**Method:** POST

**Auth:** None.

**Request fields:**
- `member_id` (string, required)

**Success (HTTP 200):**
```
{ ok: true, partners: [{ member_id, display_name, member_number, play_count, is_recent }],
  cached_at }
```
On RPC error (non-fatal): `{ ok: true, partners: [], cached_at: null, source: 'error' }` HTTP 200.

**Errors:**
```
{ ok: false, error: 'member_id is required' }  HTTP 400
```

---

## 7. Settings & Configuration

### get-settings

**Purpose:** Return all system settings, operating hours, and upcoming overrides.

**Method:** GET or POST

**Auth:** None.

**Request:** No body.

**Success (HTTP 200):**
```
{ ok: true, code: 'OK', message: '', serverNow,
  data: { settings: { ball_price_cents, guest_fee_weekday_cents, guest_fee_weekend_cents,
                      singles_duration_minutes, doubles_duration_minutes, ... },
          settings_updated_at,
          operating_hours: [{ day_of_week, day_name, opens_at, closes_at, is_closed }],
          upcoming_overrides: [...] } }
```

**Errors:**
```
{ ok: false, code: 'INTERNAL_ERROR', ... }  HTTP 500
```

**Notes:** Uses local response helpers.

---

### update-system-settings

**Purpose:** Admin action to update system settings, operating hours, or overrides.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `device_id` (string, required)
- `device_type` (string, required)
- `settings` (object, optional) — key-value pairs; valid keys: `ball_price_cents`, `guest_fee_weekday_cents`, `guest_fee_weekend_cents`, `singles_duration_minutes`, `doubles_duration_minutes`, `auto_clear_enabled` (boolean string), `auto_clear_minutes` (60–720), `check_status_minutes` (30–600), `block_warning_minutes` (15–120)
- `operating_hours` (array, optional) — each: `{ day_of_week, opens_at, closes_at, is_closed? }`
- `operating_hours_override` (object, optional) — `{ date (YYYY-MM-DD), opens_at?, closes_at?, is_closed, reason? }`
- `delete_override` (string, optional) — YYYY-MM-DD date to remove override for
- `initiated_by` (`'user'` | `'ai_assistant'`, optional)

**Success (HTTP 200):**
```
{ ok: true, updated: { settings?, operating_hours?, operating_hours_override?, deleted_override? } }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```
Throws on: missing device_id, nothing to update, device not found, not admin, invalid settings key/value, time format errors, cross-field constraint violation (`check_status_minutes >= auto_clear_minutes`).

---

### generate-location-token

**Purpose:** Generate a short-lived JWT for QR-based location verification (replaces GPS for kiosk/admin devices).

**Method:** POST

**Auth:** Kiosk or admin device (not mobile).

**Request fields:**
- `device_id` (string, required)
- `validity_minutes` (integer, optional — default 5)

**Success (HTTP 200):**
```
{ ok: true, token, expiresAt, serverNow }
```

**Errors:**
| Code | HTTP | When |
|------|------|------|
| `MISSING_DEVICE` | 400 | No device_id |
| `INVALID_DEVICE` | 401 | Device not found |
| `DEVICE_INACTIVE` | 401 | Device inactive |
| `UNAUTHORIZED` | 403 | Mobile device |
| `INSERT_FAILED` | 500 | DB insert failed |
| `INTERNAL_ERROR` | 500 | Catch-all |

---

## 8. Transactions & Billing

### get-transactions

**Purpose:** Filtered transaction list for reporting.

**Method:** GET

**Auth:** None.

**Query params (all optional):**
- `date_start`, `date_end`, `type`, `member_number`, `limit` (default 100)

**Success (HTTP 200):**
```
{ ok: true,
  summary: { total_count, guest_fees: { count, total_cents, total_dollars },
             ball_purchases: {...}, reversals: {...} },
  transactions: [{ id, date, time, type, amount_cents, amount_dollars, description,
                   member_number, account_name, session_id }] }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```

---

### purchase-balls

**Purpose:** Record a ball purchase transaction for a session. Supports split billing.

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `device_id` (string, required)
- `device_type` (string, required)
- `session_id` (string, required)
- `account_id` (string, required)
- `split_balls` (boolean, optional)
- `split_account_ids` (string[], optional — required when split_balls is true)
- `idempotency_key` (string, optional)

**Success (HTTP 200):**
```
{ ok: true, serverNow, transactions: [{ id, account_id, amount_cents, amount_dollars, description }],
  total_cents, idempotent? }
```
Idempotent hit: same shape with `idempotent: true`.

**Catch errors (throw-to-catch, HTTP 200):**
```
{ ok: false, serverNow, error: message }
```
Throws on: missing fields, device not found, session not found, RPC failure.

---

### export-transactions

**Purpose:** Export transactions in Jonas billing format (CSV). Admin only.

**Method:** POST

**Auth:** Admin device only.

**Request fields:**
- `date_range_start` (YYYY-MM-DD, required)
- `date_range_end` (YYYY-MM-DD, required)
- `device_id` (string, required)
- `device_type` (string, optional)
- `include_already_exported` (boolean, optional — default false)
- `initiated_by` (`'user'` | `'ai_assistant'` | `'system'`, optional)

**Success (HTTP 200):**
```
{ ok: true, export_id, record_count,
  summary: { total_transactions, guest_fees, ball_purchases, reversals, total_amount },
  csv: string | null }
```
`csv` is null when `record_count` is 0.

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```
Throws on: missing/invalid dates, end < start, device not found, not admin, DB failures.

---

## 9. AI Assistant

### ai-assistant

**Purpose:** Claude-powered assistant that can read board state and execute admin actions on behalf of the user (3-phase: read → draft → execute).

**Method:** POST

**Auth:** Any registered device.

**Request fields:**
- `prompt` (string, required — max 2000 chars)
- `device_id` (string, required)
- `device_type` (string, required)
- `mode` (`'read'` | `'draft'` | `'execute'`, optional — default `'draft'`)
- `actions_token` (string, optional — required for `execute` mode; signed JWT from a prior `draft` response)
- `confirm_destructive` (boolean, optional — required in `execute` mode for high-risk tools)

**Tools available:**
- Read-only: `get_court_status`, `get_session_history`, `get_transactions`, `get_blocks`, `get_analytics`
- Low-risk: `create_block`, `cancel_block`, `move_court`
- High-risk: `update_settings`, `add_holiday_hours`, `end_session`, `clear_all_courts`, `clear_waitlist`

In `read` mode, only read-only tools are offered. `draft` and `execute` modes get all tools.

**Success — draft mode (HTTP 200):**
```
{ ok: true, response, mode: 'draft', proposed_tool_calls: [{ id, tool, args, risk, description }],
  actions_token, requires_confirmation }
```

**Success — execute mode (HTTP 200):**
```
{ ok: true, response, mode: 'execute', executed_actions: [{ tool, success, result?, error? }] }
```

**Success — read mode (HTTP 200):**
```
{ ok: true, response, mode: 'read' }
```

**Errors (inline response, no shared helpers):**
```
{ ok: false, error: message, serverNow? }  HTTP 200 or 400
```
Notable errors: `RATE_LIMITED` (too many requests), `TOKEN_REQUIRED` (execute without token), `TOKEN_INVALID`, `CONFIRMATION_REQUIRED` (high-risk without confirm), `PROMPT_TOO_LONG`, `CONTEXT_TOO_LARGE`.

**Notes:** Requires `AI_ACTIONS_SECRET` env var for JWT signing. Actions token expires; re-draft if stale.

---

## 10. Members & Utilities

### get-members

**Purpose:** Search member records by name, account, or member number.

**Method:** GET

**Auth:** None.

**Query params (all optional):**
- `search` (string) — searches display_name
- `account_id` (UUID)
- `member_number` (string)

**Success (HTTP 200):**
```
{ ok: true, count, members: [{ id, display_name, is_primary, account_id,
  member_number, account_name, plays_180d, uncleared_streak }] }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 400
```

---

### hello-world

**Purpose:** Connectivity and DB health check — verifies read and write access.

**Method:** GET or POST

**Auth:** None.

**Request:** Optional body with `device_type`.

**Success (HTTP 200):**
```
{ ok: true, message: 'Hello from NOLTC Backend!', timestamp,
  checks: { database_read, database_write, court_count, settings_count }, settings }
```

**Errors:**
```
{ ok: false, error: message }  HTTP 500
```

---

### debug-query

**Purpose:** Dev tool — inspect a session's state, events, and view membership. Hardcoded to a specific session UUID unless overridden in body.

**Method:** POST

**Auth:** None.

**Request fields (all optional):**
- `session_id` (string) — default: hardcoded UUID
- `court_id` (string) — if provided, also runs the assign-court availability query

**Success (HTTP 200):**
```
{ sessionId, courtId, sessionState, sessionEvents, activeViewResult, assignCourtQuery, analysis, errors }
```

**Notes:** No authentication. Intended for development use only. Should not be deployed to production.

---

### debug-constraints

**Purpose:** Dev tool — query DB constraints and indexes for `session_events`.

**Method:** GET or POST

**Auth:** None.

**Request:** No body.

**Success (HTTP 200):**
```
{ constraints, indexes, tableConstraints, errors }
```

**Notes:** Relies on `exec_sql` RPC which may not be available in production. Dev use only.

---

### fix-session

**Purpose:** One-off data repair — inserts a RESTORE event for a hardcoded session UUID.

**Method:** GET or POST

**Auth:** None.

**Request:** No body.

**Success (HTTP 200):**
```
{ ok: true, data, serverNow }
```

**Errors:**
```
{ ok: false, error: message }
```

**Notes:** Hardcoded session ID `75ab7b75-a212-43cd-9dba-3b9cc80706be`. Single-use migration artifact — should be disabled or removed after use.
