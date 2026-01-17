-- Backfill participant_key for existing sessions
UPDATE sessions s
SET participant_key = (
  SELECT string_agg(
    CASE
      WHEN sp.member_id IS NOT NULL THEN 'm:' || sp.member_id::text
      ELSE 'g:' || lower(trim(regexp_replace(sp.guest_name, '\s+', ' ', 'g')))
    END,
    '|' ORDER BY
      CASE
        WHEN sp.member_id IS NOT NULL THEN 'm:' || sp.member_id::text
        ELSE 'g:' || lower(trim(regexp_replace(sp.guest_name, '\s+', ' ', 'g')))
      END
  )
  FROM session_participants sp
  WHERE sp.session_id = s.id
)
WHERE s.participant_key IS NULL;

-- Set NOT NULL constraint
ALTER TABLE sessions ALTER COLUMN participant_key SET NOT NULL;

-- Update index to be non-partial now that column is NOT NULL
DROP INDEX IF EXISTS idx_sessions_participant_key_scheduled_end;
CREATE INDEX idx_sessions_participant_key_scheduled_end
ON sessions (participant_key, scheduled_end_at);
