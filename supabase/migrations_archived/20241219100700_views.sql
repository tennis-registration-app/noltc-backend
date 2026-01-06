-- Views for efficient querying

-- Active sessions view (for court board displays)
CREATE VIEW active_sessions_view AS
SELECT
  c.id AS court_id,
  c.court_number,
  c.name AS court_name,
  c.sort_order,
  s.id AS session_id,
  s.session_type,
  s.started_at,
  s.scheduled_end_at,
  s.duration_minutes,
  GREATEST(0, EXTRACT(EPOCH FROM (s.scheduled_end_at - now())) / 60) AS minutes_remaining,
  COALESCE(
    array_agg(
      CASE
        WHEN sp.participant_type = 'member' THEN m.display_name
        ELSE sp.guest_name
      END
      ORDER BY sp.created_at
    ) FILTER (WHERE sp.id IS NOT NULL),
    ARRAY[]::text[]
  ) AS participant_names
FROM courts c
LEFT JOIN sessions s ON s.court_id = c.id AND s.actual_end_at IS NULL
LEFT JOIN session_participants sp ON sp.session_id = s.id
LEFT JOIN members m ON m.id = sp.member_id
WHERE c.is_active = true
GROUP BY c.id, c.court_number, c.name, c.sort_order, s.id, s.session_type, s.started_at, s.scheduled_end_at, s.duration_minutes
ORDER BY c.sort_order;

-- Active waitlist view
CREATE VIEW active_waitlist_view AS
SELECT
  w.id AS waitlist_id,
  w.group_type,
  w.position,
  w.joined_at,
  w.status,
  EXTRACT(EPOCH FROM (now() - w.joined_at)) / 60 AS minutes_waiting,
  COALESCE(
    array_agg(
      CASE
        WHEN wm.participant_type = 'member' THEN m.display_name
        ELSE wm.guest_name
      END
      ORDER BY wm.created_at
    ) FILTER (WHERE wm.id IS NOT NULL),
    ARRAY[]::text[]
  ) AS participant_names
FROM waitlist w
LEFT JOIN waitlist_members wm ON wm.waitlist_id = w.id
LEFT JOIN members m ON m.id = wm.member_id
WHERE w.status = 'waiting'
GROUP BY w.id, w.group_type, w.position, w.joined_at, w.status
ORDER BY w.position;

-- Court availability view
CREATE VIEW court_availability_view AS
SELECT
  c.id AS court_id,
  c.court_number,
  c.name AS court_name,
  c.is_active,
  c.sort_order,
  s.id AS active_session_id,
  s.scheduled_end_at AS session_ends_at,
  b.id AS active_block_id,
  b.block_type,
  b.title AS block_title,
  b.ends_at AS block_ends_at,
  CASE
    WHEN c.is_active = false THEN 'inactive'
    WHEN b.id IS NOT NULL THEN 'blocked'
    WHEN s.id IS NOT NULL THEN 'occupied'
    ELSE 'available'
  END AS status
FROM courts c
LEFT JOIN sessions s ON s.court_id = c.id AND s.actual_end_at IS NULL
LEFT JOIN blocks b ON b.court_id = c.id
  AND b.cancelled_at IS NULL
  AND b.starts_at <= now()
  AND b.ends_at > now()
ORDER BY c.sort_order;
