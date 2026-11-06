-- AVCU production data model foundation.
-- PostgreSQL. Apply only to a dedicated development database after review.
-- Financial records are append-only; this schema does not itself authorize live banking.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_member_id text UNIQUE,
  legal_name text NOT NULL,
  email text NOT NULL UNIQUE,
  city text,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification','active','suspended','closed')),
  tier_code text NOT NULL DEFAULT 'standard',
  tier_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id),
  legacy_account_id text,
  account_number_token text NOT NULL UNIQUE,
  account_type text NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','restricted','closed')),
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  source_system text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, legacy_account_id),
  CHECK (opening_balance_minor >= 0)
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  legacy_transaction_id text,
  source_system text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  transaction_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','posted','settled','failed','reversed')),
  description text NOT NULL DEFAULT '',
  reference text,
  reverses_transaction_id uuid REFERENCES ledger_transactions(id),
  import_batch_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_system, legacy_transaction_id)
);

CREATE INDEX IF NOT EXISTS ledger_transactions_account_time_idx
  ON ledger_transactions(account_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS ledger_transactions_import_batch_idx
  ON ledger_transactions(import_batch_id);

CREATE TABLE IF NOT EXISTS money_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id),
  request_type text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','information_required','approved','rejected','cancelled','posted')),
  member_note text,
  operator_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS loan_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','information_required','recommended','approved','rejected','cancelled','disbursed')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  approved_by uuid,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS funding_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_minor bigint NOT NULL CHECK (target_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','review','active','paused','closed')),
  return_disclosure text NOT NULL,
  risk_disclosure text NOT NULL,
  opens_at timestamptz,
  closes_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES funding_pools(id),
  member_id uuid NOT NULL REFERENCES members(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('pledged','pending','confirmed','cancelled','refunded')),
  provider_reference text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_roles (
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('operator','management','super_admin','auditor')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, role, granted_at)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  reason text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL CHECK (outcome IN ('success','denied','failure')),
  previous_hash text,
  event_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events(entity_type, entity_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  recipient_member_id uuid NOT NULL REFERENCES members(id),
  recipient_email text NOT NULL,
  template_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','retry','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_outbox_ready_idx
  ON notification_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL,
  source_file_hash text NOT NULL,
  started_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('staged','validating','blocked','reconciled','approved','imported','rolled_back')),
  source_record_count bigint NOT NULL DEFAULT 0,
  imported_record_count bigint NOT NULL DEFAULT 0,
  exception_count bigint NOT NULL DEFAULT 0,
  source_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  approved_by text,
  approval_note text,
  UNIQUE (source_system, source_file_hash)
);

-- Production permissions must be granted separately. Application code must use
-- parameterized queries and database roles with least privilege. Do not grant
-- browser clients direct write access to these tables.
