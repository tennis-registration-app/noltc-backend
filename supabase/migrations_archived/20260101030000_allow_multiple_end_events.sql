-- Allow multiple END events per session (for restore/re-end scenarios)
--
-- Problem: The idx_one_end_per_session constraint prevents a restored session
-- from being ended again. When a session is restored:
--   1. actual_end_at is set to NULL
--   2. A RESTORE event is inserted
--   3. The original END event still exists
--
-- When trying to take over the restored session again, endSession tries to
-- insert a new END event, but the unique constraint blocks it.
--
-- Solution: Drop the constraint. The active_sessions_view correctly handles
-- multiple END/RESTORE cycles by checking if the most recent RESTORE is
-- newer than the most recent END.
--
-- Event sequence examples:
--   [END] → session ended
--   [END, RESTORE] → session active (restored)
--   [END, RESTORE, END] → session ended (taken over again after restore)
--   [END, RESTORE, END, RESTORE] → session active (restored again)

DROP INDEX IF EXISTS idx_one_end_per_session;

COMMENT ON TABLE session_events IS
  'Event-sourced session lifecycle. Supports multiple END/RESTORE cycles.
   A session is active if it has no END events, or its most recent RESTORE
   is newer than its most recent END.';
