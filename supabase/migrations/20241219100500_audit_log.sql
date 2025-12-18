-- Audit log (append-only, never delete)

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT,
  device_type text NULL,
  initiated_by text NOT NULL DEFAULT 'user' CHECK (initiated_by IN ('user', 'ai_assistant', 'system')),
  member_id uuid NULL REFERENCES members(id) ON DELETE RESTRICT,
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  request_data jsonb NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  error_message text NULL,
  ip_address text NULL,
  geofence_status text NULL CHECK (geofence_status IN ('validated', 'failed', 'not_required')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_device ON audit_log(device_id, created_at);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_outcome ON audit_log(outcome);
CREATE INDEX idx_audit_log_initiated_by ON audit_log(initiated_by);
