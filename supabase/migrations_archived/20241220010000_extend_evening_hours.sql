-- Extend evening hours for testing (close at 11pm instead of 8pm/9pm)
UPDATE operating_hours SET closes_at = '23:00:00' WHERE day_of_week IN (0, 1, 2, 3, 4, 5, 6);
