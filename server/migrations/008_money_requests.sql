-- Money requests are review records only; approval does not execute a transfer.
CREATE TABLE IF NOT EXISTS money_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL UNIQUE,
  request_type TEXT NOT NULL CHECK (request_type IN ('withdrawal','transfer','account_service','other')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  member_note TEXT NOT NULL CHECK (length(trim(member_note)) BETWEEN 5 AND 2000),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','information_required','approved','rejected','cancelled')),
  approval_id UUID UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  decision_reason TEXT,
  information_requested TEXT,
  member_response TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_money_requests_member_created
  ON money_requests(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_money_requests_status_created
  ON money_requests(status, created_at DESC);

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_item_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_item_type_check
  CHECK (item_type IN ('transaction','membership','loan','money_request'));

ALTER TABLE operations_alerts
  ADD COLUMN IF NOT EXISTS money_request_id UUID REFERENCES money_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_alerts_money_request
  ON operations_alerts(alert_type, money_request_id)
  WHERE money_request_id IS NOT NULL;
