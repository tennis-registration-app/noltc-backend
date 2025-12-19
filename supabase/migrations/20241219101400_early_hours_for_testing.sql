-- Temporarily set earlier opening hours for testing
-- Can be reverted later to normal hours
UPDATE operating_hours SET opens_at = '05:00:00' WHERE day_of_week IN (4, 5, 6);
