-- Add mobile device for member self-registration
-- Mobile devices require geofence validation (must be at club)
INSERT INTO devices (id, device_type, device_name, device_token, is_active)
VALUES (
  'a0000000-0000-0000-0000-000000000003',
  'mobile',
  'Member Mobile App',
  'mobile-app-token-001',
  true
);
