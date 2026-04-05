# ADR-002: Polling Over Realtime WebSockets

## Status
Accepted

## Context

Kiosk and display clients need to show current board state (which courts are active, who is on the waitlist). Supabase offers Realtime subscriptions via WebSockets. The primary clients are unattended kiosks and wall-mounted displays running in a club environment, where network reliability and process stability matter more than sub-second latency.

## Decision

Board state is delivered via polling (`get-board` called every 30–60 seconds) rather than Supabase Realtime WebSocket subscriptions. Mutations that change board state (session start, end, waitlist join/assign) call `signalBoardChange()` from `_shared/sessionLifecycle.ts`, which writes to a `board_change_signals` table and broadcasts to a channel — but clients are not required to listen.

## Consequences

**Benefits:**
- Simpler client implementation — a `setInterval` fetch, no WebSocket lifecycle management
- More resilient on kiosk hardware where long-lived WebSocket connections may silently die
- Stateless from the server's perspective — no connection registry to maintain
- Acceptable latency for a 12-court club where the board refreshes every 30 seconds

**Trade-offs:**
- Up to 30–60 seconds of stale state on clients after a mutation
- Higher baseline request volume than event-driven updates
- The `board_change_signals` table and `signalBoardChange()` broadcast infrastructure exist in the codebase for future use; if lower latency is ever required, clients can subscribe to board-updates channel without backend changes
