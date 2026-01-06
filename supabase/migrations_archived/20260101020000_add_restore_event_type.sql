-- Add RESTORE event type to session_events table
--
-- The session_events table has a CHECK constraint that only allows:
--   ('START', 'END', 'EXTEND')
--
-- We need to add 'RESTORE' to support the undo-overtime-takeover feature.
-- RESTORE is a compensating event that re-activates a session after an END event.

-- Drop the existing constraint
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_type_check;

-- Add the new constraint with RESTORE included
ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check
  CHECK (event_type IN ('START', 'END', 'EXTEND', 'RESTORE'));

COMMENT ON TABLE session_events IS
  'Event-sourced session lifecycle events.
   START: Session created and assigned to court
   END: Session ended (completed, cleared, or takeover)
   EXTEND: Session duration extended
   RESTORE: Session re-activated after being ended (compensates for END)';
