-- Ensure board_change_signals is in the Realtime publication
-- This may have failed silently in the original migration

DO $$
BEGIN
  -- Try to add to publication (will fail silently if already added)
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE board_change_signals;
    RAISE NOTICE 'Added board_change_signals to supabase_realtime publication';
  EXCEPTION
    WHEN duplicate_object THEN
      RAISE NOTICE 'board_change_signals already in publication';
    WHEN undefined_object THEN
      RAISE NOTICE 'Publication does not exist, creating...';
      CREATE PUBLICATION supabase_realtime FOR TABLE board_change_signals;
  END;
END $$;

-- Also enable REPLICA IDENTITY FULL for proper change tracking
ALTER TABLE board_change_signals REPLICA IDENTITY FULL;
