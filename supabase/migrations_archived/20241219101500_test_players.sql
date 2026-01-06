-- Import 40 test players to match legacy frontend data
-- Each player gets their own account with member_number 1003-1040
-- (1001-1002 already created in test_seed_data.sql)

-- Create 38 more test accounts (member_numbers 1003-1040)
INSERT INTO accounts (id, member_number, account_name, status) VALUES
  ('b0000000-0000-0000-0000-000000000003', '1003', 'Djokovic Family', 'active'),
  ('b0000000-0000-0000-0000-000000000004', '1004', 'Medvedev Family', 'active'),
  ('b0000000-0000-0000-0000-000000000005', '1005', 'Zverev Family', 'active'),
  ('b0000000-0000-0000-0000-000000000006', '1006', 'Rublev Family', 'active'),
  ('b0000000-0000-0000-0000-000000000007', '1007', 'Hurkacz Family', 'active'),
  ('b0000000-0000-0000-0000-000000000008', '1008', 'Ruud Family', 'active'),
  ('b0000000-0000-0000-0000-000000000009', '1009', 'Fritz Family', 'active'),
  ('b0000000-0000-0000-0000-000000000010', '1010', 'Tsitsipas Family', 'active'),
  ('b0000000-0000-0000-0000-000000000011', '1011', 'Tiafoe Family', 'active'),
  ('b0000000-0000-0000-0000-000000000012', '1012', 'Paul Family', 'active'),
  ('b0000000-0000-0000-0000-000000000013', '1013', 'Dimitrov Family', 'active'),
  ('b0000000-0000-0000-0000-000000000014', '1014', 'Khachanov Family', 'active'),
  ('b0000000-0000-0000-0000-000000000015', '1015', 'Shelton Family', 'active'),
  ('b0000000-0000-0000-0000-000000000016', '1016', 'Musetti Family', 'active'),
  ('b0000000-0000-0000-0000-000000000017', '1017', 'Baez Family', 'active'),
  ('b0000000-0000-0000-0000-000000000018', '1018', 'Jarry Family', 'active'),
  ('b0000000-0000-0000-0000-000000000019', '1019', 'Humbert Family', 'active'),
  ('b0000000-0000-0000-0000-000000000020', '1020', 'Cerundolo Family', 'active'),
  ('b0000000-0000-0000-0000-000000000021', '1021', 'Thompson Family', 'active'),
  ('b0000000-0000-0000-0000-000000000022', '1022', 'Bublik Family', 'active'),
  ('b0000000-0000-0000-0000-000000000023', '1023', 'Mannarino Family', 'active'),
  ('b0000000-0000-0000-0000-000000000024', '1024', 'Korda Family', 'active'),
  ('b0000000-0000-0000-0000-000000000025', '1025', 'Griekspoor Family', 'active'),
  ('b0000000-0000-0000-0000-000000000026', '1026', 'Tabilo Family', 'active'),
  ('b0000000-0000-0000-0000-000000000027', '1027', 'Arnaldi Family', 'active'),
  ('b0000000-0000-0000-0000-000000000028', '1028', 'Fils Family', 'active'),
  ('b0000000-0000-0000-0000-000000000029', '1029', 'Lehecka Family', 'active'),
  ('b0000000-0000-0000-0000-000000000030', '1030', 'Draper Family', 'active'),
  ('b0000000-0000-0000-0000-000000000031', '1031', 'Fokina Family', 'active'),
  ('b0000000-0000-0000-0000-000000000032', '1032', 'Struff Family', 'active'),
  ('b0000000-0000-0000-0000-000000000033', '1033', 'Nakashima Family', 'active'),
  ('b0000000-0000-0000-0000-000000000034', '1034', 'Etcheverry Family', 'active'),
  ('b0000000-0000-0000-0000-000000000035', '1035', 'Popyrin Family', 'active'),
  ('b0000000-0000-0000-0000-000000000036', '1036', 'Safiullin Family', 'active'),
  ('b0000000-0000-0000-0000-000000000037', '1037', 'Karatsev Family', 'active'),
  ('b0000000-0000-0000-0000-000000000038', '1038', 'Coric Family', 'active'),
  ('b0000000-0000-0000-0000-000000000039', '1039', 'Norrie Family', 'active'),
  ('b0000000-0000-0000-0000-000000000040', '1040', 'Evans Family', 'active')
ON CONFLICT (member_number) DO NOTHING;

-- Create primary members for each new account
INSERT INTO members (id, account_id, display_name, is_primary, status) VALUES
  ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000003', 'Novak Djokovic', true, 'active'),
  ('c0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000004', 'Daniil Medvedev', true, 'active'),
  ('c0000000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000005', 'Alexander Zverev', true, 'active'),
  ('c0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000006', 'Andrey Rublev', true, 'active'),
  ('c0000000-0000-0000-0000-000000000009', 'b0000000-0000-0000-0000-000000000007', 'Hubert Hurkacz', true, 'active'),
  ('c0000000-0000-0000-0000-000000000010', 'b0000000-0000-0000-0000-000000000008', 'Casper Ruud', true, 'active'),
  ('c0000000-0000-0000-0000-000000000011', 'b0000000-0000-0000-0000-000000000009', 'Taylor Fritz', true, 'active'),
  ('c0000000-0000-0000-0000-000000000012', 'b0000000-0000-0000-0000-000000000010', 'Stefanos Tsitsipas', true, 'active'),
  ('c0000000-0000-0000-0000-000000000013', 'b0000000-0000-0000-0000-000000000011', 'Frances Tiafoe', true, 'active'),
  ('c0000000-0000-0000-0000-000000000014', 'b0000000-0000-0000-0000-000000000012', 'Tommy Paul', true, 'active'),
  ('c0000000-0000-0000-0000-000000000015', 'b0000000-0000-0000-0000-000000000013', 'Grigor Dimitrov', true, 'active'),
  ('c0000000-0000-0000-0000-000000000016', 'b0000000-0000-0000-0000-000000000014', 'Karen Khachanov', true, 'active'),
  ('c0000000-0000-0000-0000-000000000017', 'b0000000-0000-0000-0000-000000000015', 'Ben Shelton', true, 'active'),
  ('c0000000-0000-0000-0000-000000000018', 'b0000000-0000-0000-0000-000000000016', 'Lorenzo Musetti', true, 'active'),
  ('c0000000-0000-0000-0000-000000000019', 'b0000000-0000-0000-0000-000000000017', 'Sebastian Baez', true, 'active'),
  ('c0000000-0000-0000-0000-000000000020', 'b0000000-0000-0000-0000-000000000018', 'Nicolas Jarry', true, 'active'),
  ('c0000000-0000-0000-0000-000000000021', 'b0000000-0000-0000-0000-000000000019', 'Ugo Humbert', true, 'active'),
  ('c0000000-0000-0000-0000-000000000022', 'b0000000-0000-0000-0000-000000000020', 'Francisco Cerundolo', true, 'active'),
  ('c0000000-0000-0000-0000-000000000023', 'b0000000-0000-0000-0000-000000000021', 'Jordan Thompson', true, 'active'),
  ('c0000000-0000-0000-0000-000000000024', 'b0000000-0000-0000-0000-000000000022', 'Alexander Bublik', true, 'active'),
  ('c0000000-0000-0000-0000-000000000025', 'b0000000-0000-0000-0000-000000000023', 'Adrian Mannarino', true, 'active'),
  ('c0000000-0000-0000-0000-000000000026', 'b0000000-0000-0000-0000-000000000024', 'Sebastian Korda', true, 'active'),
  ('c0000000-0000-0000-0000-000000000027', 'b0000000-0000-0000-0000-000000000025', 'Tallon Griekspoor', true, 'active'),
  ('c0000000-0000-0000-0000-000000000028', 'b0000000-0000-0000-0000-000000000026', 'Alejandro Tabilo', true, 'active'),
  ('c0000000-0000-0000-0000-000000000029', 'b0000000-0000-0000-0000-000000000027', 'Matteo Arnaldi', true, 'active'),
  ('c0000000-0000-0000-0000-000000000030', 'b0000000-0000-0000-0000-000000000028', 'Arthur Fils', true, 'active'),
  ('c0000000-0000-0000-0000-000000000031', 'b0000000-0000-0000-0000-000000000029', 'Jiri Lehecka', true, 'active'),
  ('c0000000-0000-0000-0000-000000000032', 'b0000000-0000-0000-0000-000000000030', 'Jack Draper', true, 'active'),
  ('c0000000-0000-0000-0000-000000000033', 'b0000000-0000-0000-0000-000000000031', 'Alejandro Fokina', true, 'active'),
  ('c0000000-0000-0000-0000-000000000034', 'b0000000-0000-0000-0000-000000000032', 'Jan-Lennard Struff', true, 'active'),
  ('c0000000-0000-0000-0000-000000000035', 'b0000000-0000-0000-0000-000000000033', 'Brandon Nakashima', true, 'active'),
  ('c0000000-0000-0000-0000-000000000036', 'b0000000-0000-0000-0000-000000000034', 'Tomas Etcheverry', true, 'active'),
  ('c0000000-0000-0000-0000-000000000037', 'b0000000-0000-0000-0000-000000000035', 'Alexei Popyrin', true, 'active'),
  ('c0000000-0000-0000-0000-000000000038', 'b0000000-0000-0000-0000-000000000036', 'Roman Safiullin', true, 'active'),
  ('c0000000-0000-0000-0000-000000000039', 'b0000000-0000-0000-0000-000000000037', 'Aslan Karatsev', true, 'active'),
  ('c0000000-0000-0000-0000-000000000040', 'b0000000-0000-0000-0000-000000000038', 'Borna Coric', true, 'active'),
  ('c0000000-0000-0000-0000-000000000041', 'b0000000-0000-0000-0000-000000000039', 'Cameron Norrie', true, 'active'),
  ('c0000000-0000-0000-0000-000000000042', 'b0000000-0000-0000-0000-000000000040', 'Daniel Evans', true, 'active')
ON CONFLICT DO NOTHING;

-- Add spouse/secondary members to some accounts for family testing
INSERT INTO members (id, account_id, display_name, is_primary, status) VALUES
  -- Spouses for first 5 new families
  ('c0000000-0000-0000-0000-000000000043', 'b0000000-0000-0000-0000-000000000003', 'Jelena Djokovic', false, 'active'),
  ('c0000000-0000-0000-0000-000000000044', 'b0000000-0000-0000-0000-000000000004', 'Daria Medvedeva', false, 'active'),
  ('c0000000-0000-0000-0000-000000000045', 'b0000000-0000-0000-0000-000000000005', 'Sophia Zverev', false, 'active'),
  ('c0000000-0000-0000-0000-000000000046', 'b0000000-0000-0000-0000-000000000006', 'Anastasia Rubleva', false, 'active'),
  ('c0000000-0000-0000-0000-000000000047', 'b0000000-0000-0000-0000-000000000007', 'Anna Hurkacz', false, 'active')
ON CONFLICT DO NOTHING;

-- Update existing Smith/Johnson accounts to use tennis names for consistency
UPDATE accounts SET account_name = 'Sinner Family' WHERE member_number = '1001';
UPDATE accounts SET account_name = 'Alcaraz Family' WHERE member_number = '1002';

UPDATE members SET display_name = 'Jannik Sinner' WHERE id = 'c0000000-0000-0000-0000-000000000001';
UPDATE members SET display_name = 'Anna Sinner' WHERE id = 'c0000000-0000-0000-0000-000000000002';
UPDATE members SET display_name = 'Carlos Alcaraz' WHERE id = 'c0000000-0000-0000-0000-000000000003';
UPDATE members SET display_name = 'Maria Alcaraz' WHERE id = 'c0000000-0000-0000-0000-000000000004';
