-- Set early opening hours (5:00 AM) for all days for testing
UPDATE operating_hours SET opens_at = '05:00:00' WHERE day_of_week IN (0, 1, 2, 3, 4, 5, 6);
