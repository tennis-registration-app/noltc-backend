-- Enforce one active session per court at the database level.
--
-- Background: the assign-court and assign-from-waitlist edge functions check
-- for an existing active session on the target court, but the check and the
-- INSERT are not in the same transaction. Under concurrent requests two rows
-- can be inserted for the same court before either commits. A prior migration
-- (20251227170000_unique_active_session_per_court.sql) was rolled back and
-- archived; this re-introduces the constraint after verifying no duplicate
-- rows currently exist.
--
-- Diagnostic run 2026-04-18 against production:
--   SELECT court_id, COUNT(*) FROM sessions
--    WHERE actual_end_at IS NULL GROUP BY court_id HAVING COUNT(*) > 1;
-- returned 0 rows, so CREATE UNIQUE INDEX succeeds without remediation.

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_session_per_court
ON sessions(court_id)
WHERE actual_end_at IS NULL;

COMMENT ON INDEX uq_one_active_session_per_court IS
  'Enforces single active session per court. Relied on by assign-court and assign-from-waitlist as the authoritative race-condition guard.';
