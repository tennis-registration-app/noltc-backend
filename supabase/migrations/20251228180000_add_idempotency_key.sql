-- Add idempotency_key to transactions table for deduplication
-- This prevents duplicate charges if a request is retried

ALTER TABLE transactions
ADD COLUMN idempotency_key text NULL;

-- Unique constraint to prevent duplicate transactions with same idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key
ON transactions(idempotency_key)
WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN transactions.idempotency_key IS
  'Client-provided key to prevent duplicate transactions on retry';
