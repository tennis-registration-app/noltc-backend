-- Seed data: courts, system settings, operating hours

-- Insert 12 courts
INSERT INTO courts (court_number, name, sort_order) VALUES
  (1, 'Court 1', 1),
  (2, 'Court 2', 2),
  (3, 'Court 3', 3),
  (4, 'Court 4', 4),
  (5, 'Court 5', 5),
  (6, 'Court 6', 6),
  (7, 'Court 7', 7),
  (8, 'Court 8', 8),
  (9, 'Court 9', 9),
  (10, 'Court 10', 10),
  (11, 'Court 11', 11),
  (12, 'Court 12', 12);

-- Insert system settings
INSERT INTO system_settings (key, value) VALUES
  ('ball_price_cents', '500'),
  ('guest_fee_weekday_cents', '1500'),
  ('guest_fee_weekend_cents', '2000'),
  ('singles_duration_minutes', '60'),
  ('doubles_duration_minutes', '90');

-- Insert operating hours (day_of_week: 0=Sunday, 1=Monday, etc.)
INSERT INTO operating_hours (day_of_week, opens_at, closes_at) VALUES
  (0, '07:00', '20:00'),  -- Sunday
  (1, '06:30', '21:00'),  -- Monday
  (2, '06:30', '21:00'),  -- Tuesday
  (3, '06:30', '21:00'),  -- Wednesday
  (4, '06:30', '21:00'),  -- Thursday
  (5, '06:30', '20:00'),  -- Friday
  (6, '07:00', '20:00');  -- Saturday
