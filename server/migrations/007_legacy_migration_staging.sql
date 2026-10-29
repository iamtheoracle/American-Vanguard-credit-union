-- Staging-only legacy import records. No endpoint in this migration can cut over or post balances.
CREATE TABLE IF NOT EXISTS migration_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  source_payload_sha256 CHAR(64) NOT NULL,
  created_by UUID NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged','validated','blocked','reconciled','approved','imported','failed')),
  source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  exception_count INTEGER NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  source_totals JSONB NOT NULL DEFAULT '[]'::jsonb,
  exception_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  reconciliation_result JSONB,
  approved_by UUID REFERENCES operators(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  CHECK (accepted_count + exception_count <= source_count)
);

CREATE INDEX IF NOT EXISTS idx_migration_batches_status_created
  ON migration_batches(status, created_at DESC);

CREATE TABLE IF NOT EXISTS migration_staged_transactions (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES migration_batches(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  source_system TEXT,
  source_transaction_id TEXT,
  source_account_id TEXT,
  occurred_at TIMESTAMPTZ,
  original_timestamp TEXT,
  amount_minor BIGINT,
  currency CHAR(3),
  status TEXT,
  description TEXT,
  reference TEXT,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('accepted','exception')),
  exception_code TEXT,
  exception_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_migration_staged_batch_status
  ON migration_staged_transactions(batch_id, validation_status, row_number);
CREATE INDEX IF NOT EXISTS idx_migration_staged_source_key
  ON migration_staged_transactions(source_system, source_transaction_id);
