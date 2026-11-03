-- AVCU core schema. Money is stored as integer minor units (cents, USD).
CREATE TABLE IF NOT EXISTS members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','verified','rejected')),
  application   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('EVERYDAY','SAVINGS','GROWTH','GOAL SAVINGS')),
  name         TEXT NOT NULL,
  suffix       TEXT NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_member ON accounts(member_id);

CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL CHECK (type IN ('transfer','bill_pay','deposit','card_auth','reversal','adjustment')),
  from_account_id UUID REFERENCES accounts(id),
  to_account_id   UUID REFERENCES accounts(id),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  status          TEXT NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval','pending_review','posted','rejected','failed','reversed','completed')),
  memo            TEXT,
  payee           TEXT,
  submitted_by        UUID,
  submitted_by_type   TEXT NOT NULL DEFAULT 'member' CHECK (submitted_by_type IN ('member','operator')),
  processed_by        UUID,
  decision_reason     TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_txn_from ON transactions(from_account_id);
CREATE INDEX IF NOT EXISTS idx_txn_to ON transactions(to_account_id);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         UUID NOT NULL REFERENCES accounts(id),
  transaction_id     UUID REFERENCES transactions(id),
  direction          TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_after_cents BIGINT NOT NULL,
  memo               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, id DESC);

CREATE TABLE IF NOT EXISTS operators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super_admin','management','operator')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_sessions (
  token      TEXT PRIMARY KEY,
  member_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  token       TEXT PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type          TEXT NOT NULL CHECK (item_type IN ('transaction','membership')),
  transaction_id     UUID REFERENCES transactions(id),
  member_id          UUID REFERENCES members(id),
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','escalated','info_requested')),
  required_role      TEXT NOT NULL DEFAULT 'management'
                     CHECK (required_role IN ('operator','management','super_admin')),
  submitted_by       UUID,
  submitted_by_type  TEXT NOT NULL DEFAULT 'member' CHECK (submitted_by_type IN ('member','operator')),
  assigned_to        UUID REFERENCES operators(id),
  decided_by         UUID REFERENCES operators(id),
  decision_reason    TEXT,
  info_requested     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS support_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','in_progress','escalated','resolved')),
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  assigned_to UUID REFERENCES operators(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_messages (
  id          BIGSERIAL PRIMARY KEY,
  case_id     UUID NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('member','operator')),
  author_id   UUID,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_messages_case ON case_messages(case_id, id);

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('member','operator','system','ai')),
  actor_id    UUID,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_type TEXT NOT NULL CHECK (requester_type IN ('member','operator')),
  requester_id   UUID NOT NULL,
  purpose        TEXT NOT NULL DEFAULT 'chat',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','succeeded','failed')),
  provider       TEXT NOT NULL,
  input_excerpt  TEXT,
  output         JSONB,
  tool_calls     JSONB NOT NULL DEFAULT '[]'::jsonb,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_status ON ai_tasks(status);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  member_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last4        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  expires      TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_health (
  name            TEXT PRIMARY KEY,
  adapter         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy','degraded','down','unknown')),
  last_checked_at TIMESTAMPTZ,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          BIGSERIAL PRIMARY KEY,
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
