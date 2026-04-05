# ADR-003: Service Role Key and Honor-System Identity

## Status
Accepted

## Context

NOLTC is a private club whose kiosks and displays are physically supervised by staff. There are no public-facing endpoints. Implementing per-user JWT authentication would require member login flows, token refresh logic, and session management — significant complexity for a supervised, single-location environment.

## Decision

Edge Functions use the Supabase service role key (bypasses RLS) rather than per-user JWTs. Callers are identified by `device_id` (a UUID registered in the `devices` table) and `device_type` (`kiosk` or `mobile`). There is no cryptographic proof of caller identity — the system operates on honor and physical access control.

The anon key is used only as a Bearer token to satisfy the Edge Function gateway's JWT verification requirement. The actual authorization decisions are made inside each function using `device_id` lookup and, for mobile clients, geofence validation.

## Consequences

**Benefits:**
- No auth flow to implement or maintain
- Simple request structure: any client with the anon key and a registered device_id can call any function
- Appropriate for a private club with supervised hardware

**Trade-offs:**
- If the anon key leaks or an unregistered device is used, there is no cryptographic barrier
- Admin-level operations (`admin-end-session`, `update-system-settings`) rely on `device_type: 'admin'` check — not cryptographically enforced
- **This architecture must be re-evaluated before any internet-facing exposure.** A compromised anon key would grant full board manipulation. Mitigation path: add per-device signed tokens or move admin operations behind a separate authenticated surface
