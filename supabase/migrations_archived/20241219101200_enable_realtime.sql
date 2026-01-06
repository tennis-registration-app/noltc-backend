-- Enable Realtime for tables that need live updates
-- Clients will subscribe to these for instant UI updates

-- Sessions: Core table for court status
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;

-- Session participants: Needed to show who's on court
ALTER PUBLICATION supabase_realtime ADD TABLE session_participants;

-- Waitlist: Queue status
ALTER PUBLICATION supabase_realtime ADD TABLE waitlist;

-- Waitlist members: Who's in the queue
ALTER PUBLICATION supabase_realtime ADD TABLE waitlist_members;

-- Blocks: Court blocks affect availability
ALTER PUBLICATION supabase_realtime ADD TABLE blocks;

-- Courts: Rarely changes but needed for initial load
ALTER PUBLICATION supabase_realtime ADD TABLE courts;

-- System settings: Price changes, etc.
ALTER PUBLICATION supabase_realtime ADD TABLE system_settings;

-- Operating hours: Schedule changes
ALTER PUBLICATION supabase_realtime ADD TABLE operating_hours;

-- Operating hours overrides: Holiday closures, etc.
ALTER PUBLICATION supabase_realtime ADD TABLE operating_hours_overrides;
