-- AVCU asset-aware double-entry ledger foundation.
-- Additive only: legacy accounts/transactions/ledger_entries remain untouched.
CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL CHECK (length(trim(legal_name)) BETWEEN 2 AND 200),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  registration_country CHAR(2) NOT NULL,
  registration_number TEXT,
  kyb_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (kyb_status IN ('not_started','pending','verified','rejected','restricted')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','finance','approver','viewer')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (business_id, member_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_business_memberships_member
  ON business_memberships(member_id, status);

CREATE TABLE IF NOT EXISTS financial_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES members(id) ON DELETE RESTRICT,
  business_id UUID REFERENCES business_profiles(id) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('member','business','system')),
  account_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  account_type TEXT NOT NULL
    CHECK (account_type IN ('checking','savings','operating','reserve','custody','clearing','suspense','fee','liability','equity')),
  asset_code TEXT NOT NULL CHECK (asset_code ~ '^[A-Z0-9]{2,12}$'),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('fiat','stablecoin','internal')),
  asset_precision SMALLINT NOT NULL CHECK (asset_precision BETWEEN 0 AND 18),
  custody_domain TEXT NOT NULL CHECK (custody_domain IN ('bank','digital_asset','internal')),
  provider_name TEXT,
  provider_account_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','open','restricted','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (owner_type = 'member' AND member_id IS NOT NULL AND business_id IS NULL) OR
    (owner_type = 'business' AND business_id IS NOT NULL AND member_id IS NULL) OR
    (owner_type = 'system' AND member_id IS NULL AND business_id IS NULL)
  ),
  UNIQUE (owner_type, member_id, business_id, account_code, asset_code),
  UNIQUE (id, asset_code)
);
CREATE INDEX IF NOT EXISTS idx_financial_accounts_member_asset
  ON financial_accounts(member_id, asset_code, status) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_accounts_business_asset
  ON financial_accounts(business_id, asset_code, status) WHERE business_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_accounts_provider_ref
  ON financial_accounts(provider_name, provider_account_ref)
  WHERE provider_name IS NOT NULL AND provider_account_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS journal_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  transaction_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','posted','reversed','voided')),
  idempotency_key TEXT UNIQUE,
  request_hash CHAR(64),
  source_system TEXT,
  source_event_id TEXT,
  description TEXT,
  created_by_type TEXT NOT NULL DEFAULT 'system'
    CHECK (created_by_type IN ('member','operator','system','provider')),
  created_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  UNIQUE (source_system, source_event_id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGSERIAL PRIMARY KEY,
  journal_transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
  financial_account_id UUID NOT NULL,
  asset_code TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor NUMERIC(38,0) NOT NULL CHECK (amount_minor > 0),
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (financial_account_id, asset_code)
    REFERENCES financial_accounts(id, asset_code) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_account
  ON journal_entries(financial_account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_transaction
  ON journal_entries(journal_transaction_id, asset_code);

CREATE OR REPLACE FUNCTION avcu_assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id UUID;
  target_status TEXT;
  entry_count BIGINT;
  unbalanced_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'journal_transactions' THEN
    target_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_id := COALESCE(NEW.journal_transaction_id, OLD.journal_transaction_id);
  END IF;
  SELECT status INTO target_status FROM journal_transactions WHERE id = target_id;
  IF target_status IS DISTINCT FROM 'posted' THEN
    RETURN NULL;
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE totals.net_amount <> 0)
    INTO entry_count, unbalanced_count
    FROM (
      SELECT asset_code,
        sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) AS net_amount
      FROM journal_entries
      WHERE journal_transaction_id = target_id
      GROUP BY asset_code
    ) totals;
  IF entry_count = 0 OR unbalanced_count <> 0 OR
     (SELECT count(*) FROM journal_entries WHERE journal_transaction_id = target_id) < 2 THEN
    RAISE EXCEPTION 'Journal transaction % is not balanced per asset', target_id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_transaction_balanced';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_entries_balance_check ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balance_check
AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION avcu_assert_journal_balanced();
DROP TRIGGER IF EXISTS journal_transaction_balance_check ON journal_transactions;
CREATE CONSTRAINT TRIGGER journal_transaction_balance_check
AFTER INSERT OR UPDATE OF status ON journal_transactions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION avcu_assert_journal_balanced();

CREATE OR REPLACE FUNCTION avcu_reject_journal_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Journal entries are append-only; post a compensating transaction'
    USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries;
CREATE TRIGGER journal_entries_immutable
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION avcu_reject_journal_entry_mutation();

CREATE TABLE IF NOT EXISTS balance_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_account_id UUID NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  asset_code TEXT NOT NULL,
  amount_minor NUMERIC(38,0) NOT NULL CHECK (amount_minor > 0),
  reason TEXT NOT NULL,
  linked_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','released','captured','expired')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  FOREIGN KEY (financial_account_id, asset_code)
    REFERENCES financial_accounts(id, asset_code) ON DELETE RESTRICT,
  CHECK ((status = 'active') = (resolved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_balance_holds_active
  ON balance_holds(financial_account_id, asset_code, created_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS external_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  financial_account_id UUID NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  rail TEXT NOT NULL CHECK (rail IN ('ach_credit','ach_debit','wire','stablecoin')),
  asset_code TEXT NOT NULL,
  amount_minor NUMERIC(38,0) NOT NULL CHECK (amount_minor > 0),
  fee_minor NUMERIC(38,0) NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  destination_ref TEXT NOT NULL,
  provider_name TEXT,
  provider_payment_ref TEXT,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','risk_review','awaiting_approval','reserved','submitted','processing','settled','rejected','failed','returned','cancelled','expired','reversed','manual_review')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by UUID,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_external_payment_intents_account
  ON external_payment_intents(financial_account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_payment_provider_ref
  ON external_payment_intents(provider_name, provider_payment_ref)
  WHERE provider_name IS NOT NULL AND provider_payment_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_events (
  id BIGSERIAL PRIMARY KEY,
  provider_name TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processing','processed','ignored','retry','failed','manual_review')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error_code TEXT,
  UNIQUE (provider_name, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_events_pending
  ON provider_events(processing_status, received_at)
  WHERE processing_status IN ('received','retry');

CREATE TABLE IF NOT EXISTS financial_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_outbox_due
  ON financial_outbox(status, next_attempt_at, id)
  WHERE status IN ('pending','retry');

CREATE TABLE IF NOT EXISTS business_account_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  permission TEXT NOT NULL CHECK (permission IN ('view_balance','view_transactions','create_payment','approve_payment','manage_users')),
  per_payment_limit_minor NUMERIC(38,0) CHECK (per_payment_limit_minor IS NULL OR per_payment_limit_minor > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by UUID REFERENCES members(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (business_id, member_id, permission)
);
