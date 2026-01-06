-- Transactions and exports (append-only financial records)

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  transaction_type text NOT NULL CHECK (transaction_type IN ('guest_fee', 'ball_purchase', 'reversal')),
  amount_cents integer NOT NULL,
  description text NOT NULL,
  session_id uuid NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  related_transaction_id uuid NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  created_by_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_account_id ON transactions(account_id, created_at);
CREATE INDEX idx_transactions_session_id ON transactions(session_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_type ON transactions(transaction_type);

CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_type text NOT NULL CHECK (export_type IN ('manual', 'scheduled')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  file_path text NULL,
  record_count integer NULL,
  date_range_start timestamptz NOT NULL,
  date_range_end timestamptz NOT NULL,
  created_by_device_id uuid NULL REFERENCES devices(id) ON DELETE RESTRICT,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_exports_status ON exports(status);
CREATE INDEX idx_exports_created_at ON exports(created_at);

CREATE TABLE export_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_export_transaction UNIQUE (export_id, transaction_id)
);

CREATE INDEX idx_export_items_export_id ON export_items(export_id);
CREATE INDEX idx_export_items_transaction_id ON export_items(transaction_id);
