-- Prevent race condition: only one active session per court
-- This enforces at database level what assign-court checks at application level

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_session_per_court
ON sessions(court_id)
WHERE actual_end_at IS NULL;

COMMENT ON INDEX idx_one_active_session_per_court IS
  'Enforces single active session per court - prevents race condition duplicates';
