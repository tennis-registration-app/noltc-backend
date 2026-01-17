-- Add participant_key column to sessions table
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS participant_key TEXT;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_sessions_participant_key_scheduled_end
ON sessions (participant_key, scheduled_end_at)
WHERE participant_key IS NOT NULL;

-- Function to generate participant key from participants
-- Format: sorted list of "m:<member_id>" and "g:<normalized_guest_name>" joined by "|"
CREATE OR REPLACE FUNCTION generate_participant_key(participants JSONB)
RETURNS TEXT AS $$
DECLARE
  keys TEXT[] := '{}';
  p JSONB;
BEGIN
  FOR p IN SELECT * FROM jsonb_array_elements(participants)
  LOOP
    IF p->>'member_id' IS NOT NULL THEN
      keys := array_append(keys, 'm:' || (p->>'member_id'));
    ELSIF p->>'guest_name' IS NOT NULL THEN
      -- Normalize: lowercase, trim, collapse multiple spaces
      keys := array_append(keys, 'g:' || lower(trim(regexp_replace(p->>'guest_name', '\s+', ' ', 'g'))));
    END IF;
  END LOOP;

  -- Sort for consistent ordering
  SELECT array_agg(k ORDER BY k) INTO keys FROM unnest(keys) AS k;

  RETURN array_to_string(keys, '|');
END;
$$ LANGUAGE plpgsql IMMUTABLE;
