-- Update end_reason constraint to use new values
-- Old: 'completed', 'cleared_early', 'admin_override'
-- New: 'cleared', 'observed_cleared', 'admin_override', 'overtime_takeover', 'auto_cleared'

-- Step 1: Drop old constraint first
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_end_reason_check;

-- Step 2: Update existing data to new values
UPDATE sessions SET end_reason = 'cleared' WHERE end_reason = 'cleared_early';
UPDATE sessions SET end_reason = 'auto_cleared' WHERE end_reason = 'completed';

-- Step 3: Add new constraint
ALTER TABLE sessions ADD CONSTRAINT sessions_end_reason_check
  CHECK (end_reason IN ('cleared', 'observed_cleared', 'admin_override', 'overtime_takeover', 'auto_cleared'));
