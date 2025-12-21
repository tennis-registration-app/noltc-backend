# Row Level Security (RLS) Policies

## Overview

All tables have RLS enabled. Access is controlled as follows:

## Anon Role (Public/Kiosk Access)

**Can READ:**
- `board_change_signals` — Realtime subscription for "something changed" events
- `operating_hours` — Club hours for display
- `settings` — Public club settings

**Can EXECUTE:**
- `get_court_board(request_time)` — Returns sanitized court status
- `get_active_waitlist(request_time)` — Returns sanitized waitlist

**CANNOT read directly:**
- `accounts` — Contains member numbers, billing info
- `members` — Contains personal info
- `devices` — Contains device tokens
- `transactions` — Contains billing data
- `audit_log` — Contains sensitive history
- `sessions` — Use `get_court_board()` function instead
- `session_events` — Internal data, use signals for Realtime
- `waitlist` — Use `get_active_waitlist()` function instead
- `courts` — Use `get_court_board()` function instead
- `blocks` — Use `get_court_board()` function instead
- `session_participants` — Internal data

## Service Role (Edge Functions)

Full access to all tables for mutations and queries.

## Realtime Subscriptions

Clients subscribe to `board_change_signals` table only. This table contains:
- `id` (UUID)
- `change_type` ('session', 'waitlist', 'block')
- `created_at` (timestamp)

No sensitive data is exposed via Realtime. On any signal, clients call `get-board` Edge Function to refresh.

## Security Model

1. **Anon cannot write** — All mutations go through Edge Functions using service_role
2. **Anon cannot read sensitive tables** — Only sanitized data via SECURITY DEFINER functions
3. **Functions pin search_path** — All SECURITY DEFINER functions have `SET search_path = public, pg_temp`
4. **Signals contain no data** — Just "something changed" notifications

## Privacy

- `member_number` (family billing number) is intentionally excluded from `get_court_board()` response
- Only `display_name`, `is_guest`, and opaque `member_id` (UUID) are exposed
