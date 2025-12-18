-- Add admin device for testing
INSERT INTO devices (id, device_type, device_name, device_token, is_active)
VALUES (
  'a0000000-0000-0000-0000-000000000002',
  'admin',
  'Test Admin',
  'test-admin-token-001',
  true
);
