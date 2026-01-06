-- Test device for API testing
INSERT INTO devices (id, device_type, device_name, device_token, is_active)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'kiosk',
  'Test Kiosk',
  'test-kiosk-token-001',
  true
);

-- Test accounts
INSERT INTO accounts (id, member_number, account_name, status)
VALUES
  ('b0000000-0000-0000-0000-000000000001', '1001', 'Smith Family', 'active'),
  ('b0000000-0000-0000-0000-000000000002', '1002', 'Johnson Family', 'active');

-- Test members
INSERT INTO members (id, account_id, display_name, is_primary, status)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'John Smith', true, 'active'),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'Jane Smith', false, 'active'),
  ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'Bob Johnson', true, 'active'),
  ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'Alice Johnson', false, 'active');
