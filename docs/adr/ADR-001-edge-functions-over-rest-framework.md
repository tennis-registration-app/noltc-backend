# ADR-001: Edge Functions Over REST API Framework

## Status
Accepted

## Context

The NOLTC backend needs to serve a single private club with a fixed set of operations: court registration, waitlist management, session lifecycle, and board state reads. The data lives in Supabase (PostgreSQL). A traditional REST API framework (Express, Fastify, Hono) would require a separate hosted server, its own deployment pipeline, and manual Supabase client wiring.

## Decision

Use Supabase Edge Functions (Deno runtime) for all backend logic rather than a standalone API server. Each operation is its own function (`assign-court`, `end-session`, `join-waitlist`, etc.) deployed and versioned independently.

## Consequences

**Benefits:**
- Co-located with the database — no network hop between API layer and Supabase
- Each function deploys independently; a broken function does not take down others
- No server to provision, scale, or maintain
- Service role key is available as a runtime secret, avoiding client-side exposure
- Consistent invocation pattern: all functions are `POST /functions/v1/<name>` with a JSON body

**Trade-offs:**
- No shared middleware (auth, rate limiting, request logging) — each function must handle its own concerns
- Mitigated by the `supabase/functions/_shared/` module: response helpers, validation, session lifecycle, geofence, and operating hours are factored out and shared across all functions
- Deno runtime means TypeScript type-checking against URL imports (`https://deno.land/...`) is not possible in a Node-based tsconfig; the `_shared/` modules are typechecked separately
- No local development stack that mirrors production exactly (`supabase functions serve` works but has limitations with certain Deno APIs)
