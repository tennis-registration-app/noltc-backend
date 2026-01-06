# Post-Reset Validation Checklist

Run these checks after any database reset to ensure the baseline is correctly applied.

## 1. Seed Data Counts
```sql
SELECT 'courts' as table_name, COUNT(*) as count FROM courts
UNION ALL SELECT 'devices', COUNT(*) FROM devices
UNION ALL SELECT 'operating_hours', COUNT(*) FROM operating_hours
UNION ALL SELECT 'system_settings', COUNT(*) FROM system_settings;
```

Expected: courts=12, devices=4, operating_hours=7, system_settings=8

## 2. RPC Tests
```sql
-- Court board (should return 12 rows)
SELECT court_number, status FROM get_court_board();

-- Waitlist (should return empty or waiting entries)
SELECT * FROM get_active_waitlist();

-- Upcoming blocks (should return empty or future blocks)
SELECT * FROM get_upcoming_blocks();
```

## 3. RLS Enabled
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
AND tablename IN ('sessions', 'members', 'accounts', 'waitlist', 'blocks');
```

Expected: All rows show `rowsecurity = true`

## 4. Realtime Configured
```sql
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
AND tablename = 'board_change_signals';
```

Expected: Returns `board_change_signals`

## 5. Edge Function Test

Test get-members returns data:
```bash
curl "https://dncjloqewjubodkoruou.supabase.co/functions/v1/get-members" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

Expected: `{"ok": true, "count": N, "members": [...]}`

## 6. Permissions (if edge functions fail)

Run these grants if permission errors occur:
```sql
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
```
