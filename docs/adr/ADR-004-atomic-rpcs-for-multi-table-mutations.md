# ADR-004: Atomic RPCs for Multi-Table Mutations

## Status
Accepted

## Context

Core operations in the system touch multiple tables in a single logical action:

- **Session creation** inserts into `sessions`, `session_participants`, `transactions` (guest fees, ball purchases), and optionally updates `waitlist`
- **Session end** inserts into `session_events`, updates `sessions.actual_end_at`, and updates `members.uncleared_streak`

Performing these as sequential Supabase client calls (multiple `.from().insert()` chains) risks partial writes if any step fails — leaving the database in an inconsistent state (e.g. a session row without participants, or a ended session without a streak update).

## Decision

Multi-table mutations are implemented as PostgreSQL stored procedures called via `supabase.rpc()`:

- `create_session_with_fees` — atomically creates session, participants, and any fee transactions
- `end_session_atomic` — atomically inserts `session_events` END row, updates `sessions.actual_end_at`, and updates `members.uncleared_streak`

All session-ending code paths **must** call `endSession()` from `_shared/sessionLifecycle.ts`, which routes through `end_session_atomic`. Direct row updates that bypass this RPC are a known architectural inconsistency (one instance was fixed in the `assign-from-waitlist` overtime takeover — see ADR-006 and the recent fixes in README).

## Consequences

**Benefits:**
- Atomic — either all writes succeed or none do
- `uncleared_streak` is always updated when a session ends, regardless of which code path triggered it
- Single source of truth: `session_events` is the append-only record; `sessions.actual_end_at` is a denormalized cache

**Trade-offs:**
- Stored procedures must be deployed via the Supabase Dashboard SQL Editor rather than `supabase db push` due to a CLI parser bug with multi-statement PL/pgSQL migrations (see ADR-005)
- PL/pgSQL logic is outside the TypeScript type system and not covered by `npm run verify`
- `CREATE OR REPLACE FUNCTION` creates a new overload if parameter types change order — must use `DROP FUNCTION IF EXISTS` before redefining (this caused a production incident; see README Recent Fixes)
