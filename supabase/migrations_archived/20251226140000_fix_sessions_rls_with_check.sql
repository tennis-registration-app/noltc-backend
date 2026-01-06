-- Fix: Add WITH CHECK to sessions service_role policy
-- Without WITH CHECK, UPDATE operations silently fail (0 rows affected)
-- This mirrors the fix applied to session_events table

DROP POLICY IF EXISTS "Service role full access to sessions" ON sessions;

CREATE POLICY "Service role full access to sessions" ON sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
