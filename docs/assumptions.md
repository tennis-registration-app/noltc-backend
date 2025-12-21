# Architecture Assumptions & Decisions

## Identity Model

- **Honor system**: Users identify by 4-digit family member number
- **No PIN verification in MVP**: `members.pin_hash` column exists but unused
- **Billing derived server-side**: UI passes `memberId`, backend derives `accountId`
- **Guest support**: Guests identified by name only, billed to a member's account

## Session Lifecycle

- **Append-only events**: Sessions end via INSERT to `session_events`, not UPDATE
- **Event types**: START, END, EXTEND
- **Active session**: One without an END event (and legacy: `actual_end_at IS NULL`)
- **Transitional view**: `active_sessions_view` respects both markers during migration
- **Views compute status**: `active_sessions_view` filters based on events

## Time Handling

- **Server-authoritative**: All time calculations use `serverNow` from API
- **Consistent timestamps**: `get_court_board()` accepts `request_time` parameter
- **ISO 8601 strings**: All timestamps returned as ISO strings
- **Client display only**: Frontend formats times but never computes elapsed/remaining

## Data Access

- **Edge Functions only**: All mutations go through Edge Functions
- **Functions for reads**: Court board and waitlist read via SQL functions
- **RLS locked down**: Anon cannot read base tables directly
- **Signals for Realtime**: `board_change_signals` table triggers client refresh

## Error Handling

- **Structured responses**: All APIs return `{ ok, code, message, serverNow }`
- **Expected denials**: Return HTTP 200 with `ok: false` and denial code
- **Unexpected errors**: Return HTTP 500 with error details
- **Client refresh on denial**: "Court occupied" triggers board refresh

## Denial Codes

| Code | Meaning |
|------|---------|
| COURT_OCCUPIED | Court was taken by another user |
| COURT_BLOCKED | Court is blocked for maintenance/event |
| MEMBER_ALREADY_PLAYING | Member is already on a court |
| MEMBER_ON_WAITLIST | Member is already on waitlist |
| OUTSIDE_OPERATING_HOURS | Club is closed |
| OUTSIDE_GEOFENCE | User not physically at club |
| INVALID_MEMBER | Member ID not found |
| INVALID_REQUEST | Missing required fields |
| WAITLIST_ENTRY_NOT_FOUND | Waitlist entry doesn't exist or already assigned |
| SESSION_NOT_FOUND | No active session found |
| SESSION_ALREADY_ENDED | Session was already ended |
| COURT_NOT_FOUND | Court number not found |
| QUERY_ERROR | Database query failed |
| INTERNAL_ERROR | Unexpected server error |

## Realtime Strategy

- **Signal-based refresh**: Clients subscribe to `board_change_signals`
- **No payload parsing**: Signals contain only `change_type`, no sensitive data
- **Debounced refresh**: Multiple rapid signals trigger single refresh
- **Full board fetch**: On any signal, client calls `get-board` for complete state
