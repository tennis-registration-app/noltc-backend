-- ============================================================================
-- FIX: session_events RLS policy missing WITH CHECK clause
-- ============================================================================
--
-- The original policy "Service role full access to session_events" used:
--   FOR ALL TO service_role USING (true)
--
-- This is INCORRECT for INSERT operations. RLS requires WITH CHECK for new rows.
-- Without WITH CHECK, INSERT silently fails (returns empty result).
--
-- Fix: Add WITH CHECK (true) to allow service_role to INSERT.
-- ============================================================================

BEGIN;

-- Drop the broken policy
DROP POLICY IF EXISTS "Service role full access to session_events" ON session_events;

-- Create correct policy with both USING (for SELECT/UPDATE/DELETE) and WITH CHECK (for INSERT/UPDATE)
CREATE POLICY "Service role full access to session_events" ON session_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Verify: The policy should now allow:
-- - SELECT: USING (true) allows reading all rows
-- - INSERT: WITH CHECK (true) allows inserting any row
-- - UPDATE: USING (true) for which rows, WITH CHECK (true) for new values
-- - DELETE: USING (true) allows deleting any row

COMMIT;
