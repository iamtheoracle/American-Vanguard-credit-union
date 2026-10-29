CREATE TABLE avcu_workflow_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by text NOT NULL,
  type text NOT NULL CHECK (type IN ('internal-transfer','bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','check-deposit','card-authorization')),
  source_account text NOT NULL CHECK (source_account IN ('draft','primary','market','holiday','business','ira','certificate','retirement401k')),
  destination_account text CHECK (destination_account IS NULL OR destination_account IN ('draft','primary','market','holiday','business','ira','certificate','retirement401k')),
  recipient text NOT NULL DEFAULT '',
  destination_details text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'USD',
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 180),
  status text NOT NULL DEFAULT 'pending-approval' CHECK (status IN ('pending-approval','needs-information','rejected','approved','approved-awaiting-provider','processing','settled')),
  assigned_team text NOT NULL,
  assigned_role text NOT NULL,
  operator_note text NOT NULL DEFAULT '',
  provider_state text NOT NULL DEFAULT 'not-connected',
  recipient_verified boolean NOT NULL DEFAULT false,
  secure_document_key text,
  idempotency_key text NOT NULL,
  decision_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by, idempotency_key),
  CHECK ((type = 'internal-transfer' AND destination_account IS NOT NULL AND destination_account <> source_account) OR (type <> 'internal-transfer' AND destination_account IS NULL))
);

CREATE INDEX avcu_workflow_member_created_idx ON avcu_workflow_requests (created_by, created_at DESC);
CREATE INDEX avcu_workflow_queue_idx ON avcu_workflow_requests (status, created_at ASC);

CREATE TABLE avcu_workflow_audit (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES avcu_workflow_requests(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX avcu_workflow_audit_request_idx ON avcu_workflow_audit (request_id, created_at ASC);

CREATE TABLE avcu_account_balances (
  member_id text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('draft','primary','market','holiday','business','ira','certificate','retirement401k')),
  balance_cents bigint NOT NULL CHECK (balance_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, account_type)
);

CREATE TABLE avcu_account_ledger (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES avcu_workflow_requests(id),
  member_id text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('draft','primary','market','holiday','business','ira','certificate','retirement401k')),
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, account_type, direction)
);
