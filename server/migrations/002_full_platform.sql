-- AVCU platform expansion: member identity, account numbers, money requests,
-- rewards, share certificates, loans, and preserved historical transaction data.

-- ---- member identity -------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS member_number_seq START WITH 10000001;

ALTER TABLE members ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS member_number TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS mailing_address TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

UPDATE members
   SET member_number = nextval('member_number_seq')::text
 WHERE member_number IS NULL;

UPDATE members
   SET username = nullif(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g'), '')
 WHERE username IS NULL;

-- Guarantee uniqueness for pre-existing rows before the unique index is added.
UPDATE members m
   SET username = m.username || '.' || right(replace(m.id::text, '-', ''), 4)
 WHERE m.username IS NULL
    OR m.username IN (SELECT username FROM members GROUP BY username HAVING count(*) > 1);

ALTER TABLE members ALTER COLUMN username SET NOT NULL;
ALTER TABLE members ALTER COLUMN member_number SET NOT NULL;
ALTER TABLE members ALTER COLUMN member_number SET DEFAULT nextval('member_number_seq')::text;

CREATE UNIQUE INDEX IF NOT EXISTS members_member_number_key ON members (member_number);
CREATE UNIQUE INDEX IF NOT EXISTS members_username_lower_key ON members (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS members_email_lower_key ON members (lower(email));

-- ---- accounts --------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS account_number_seq START WITH 10000001;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS routing_number TEXT NOT NULL DEFAULT '091000019';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

UPDATE accounts
   SET account_number = '4002' || lpad(nextval('account_number_seq')::text, 8, '0')
 WHERE account_number IS NULL;
UPDATE accounts SET opened_at = created_at WHERE opened_at IS NULL;

ALTER TABLE accounts ALTER COLUMN account_number
  SET DEFAULT '4002' || lpad(nextval('account_number_seq')::text, 8, '0');
ALTER TABLE accounts ALTER COLUMN account_number SET NOT NULL;
ALTER TABLE accounts ALTER COLUMN opened_at SET NOT NULL;
ALTER TABLE accounts ALTER COLUMN opened_at SET DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_number_key ON accounts (account_number);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('EVERYDAY','SAVINGS','GROWTH','GOAL SAVINGS','TERM SHARE'));

-- ---- transactions: original dates, sources, references ---------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'member';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_reference TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_batch_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT;

UPDATE transactions SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE transactions ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE transactions ALTER COLUMN occurred_at SET DEFAULT now();

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('transfer','bill_pay','deposit','card_auth','reversal','adjustment',
                  'loan_disbursement','loan_payment','request_payment','certificate'));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('pending_approval','pending_review','posted','rejected','failed',
                    'reversed','completed','declined'));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('member','operator','import','system','ai'));

CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_external_ref ON transactions(external_reference);

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
UPDATE ledger_entries SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE ledger_entries ALTER COLUMN occurred_at SET DEFAULT now();

-- ---- approvals: loan decisions --------------------------------------------
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_item_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_item_type_check
  CHECK (item_type IN ('transaction','membership','loan'));

-- ---- notifications ---------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'info';

-- ---- payment requests ------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  payer_member_id    UUID REFERENCES members(id) ON DELETE SET NULL,
  payer_email        TEXT,
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  memo               TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','paid','declined','cancelled','expired')),
  transaction_id     UUID REFERENCES transactions(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_requests_payer ON payment_requests(payer_member_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON payment_requests(requester_member_id, status);

-- ---- rewards ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reward_entries (
  id             BIGSERIAL PRIMARY KEY,
  member_id      UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  points         INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  transaction_id UUID REFERENCES transactions(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rewards_member ON reward_entries(member_id, id DESC);

-- ---- share certificate commitments ----------------------------------------
CREATE TABLE IF NOT EXISTS certificate_commitments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES accounts(id),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  term_months    INTEGER NOT NULL CHECK (term_months IN (6,12,24,36)),
  apy_bps        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','matured','closed')),
  transaction_id UUID REFERENCES transactions(id),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  matures_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_certificates_member ON certificate_commitments(member_id, opened_at DESC);

-- ---- loans and repayments --------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id              UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  reference              TEXT NOT NULL UNIQUE,
  product                TEXT NOT NULL CHECK (product IN ('PERSONAL','AUTO','SHARE_SECURED')),
  principal_cents        BIGINT NOT NULL CHECK (principal_cents > 0),
  balance_cents          BIGINT NOT NULL CHECK (balance_cents >= 0),
  apr_bps                INTEGER NOT NULL CHECK (apr_bps >= 0),
  term_months            INTEGER NOT NULL CHECK (term_months BETWEEN 6 AND 84),
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','declined','active','paid_off','cancelled')),
  purpose                TEXT,
  monthly_payment_cents  BIGINT,
  next_due_date          DATE,
  disbursement_account_id UUID REFERENCES accounts(id),
  approval_id            UUID REFERENCES approvals(id),
  transaction_id         UUID REFERENCES transactions(id),
  decision_reason        TEXT,
  approved_by            UUID REFERENCES operators(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);

CREATE TABLE IF NOT EXISTS loan_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id        UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  member_id      UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  principal_cents BIGINT NOT NULL CHECK (principal_cents >= 0),
  interest_cents BIGINT NOT NULL CHECK (interest_cents >= 0),
  transaction_id UUID REFERENCES transactions(id),
  due_date       DATE,
  status         TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('scheduled','paid','failed')),
  paid_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan ON loan_payments(loan_id, paid_at DESC);

-- ---- historical imports ----------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID NOT NULL REFERENCES operators(id),
  filename      TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  posted_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  total_cents   BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','failed')),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- email verification ----------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
  member_id  UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
