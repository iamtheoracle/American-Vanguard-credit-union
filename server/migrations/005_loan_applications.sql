-- Loan applications are review records only. Approval does not disburse funds.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_item_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_item_type_check
  CHECK (item_type IN ('transaction','membership','loan'));

CREATE TABLE IF NOT EXISTS loan_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL UNIQUE,
  requested_amount_cents BIGINT NOT NULL CHECK (requested_amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  requested_term_months INTEGER CHECK (requested_term_months IS NULL OR requested_term_months > 0),
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','information_required','approved','rejected','cancelled')),
  approval_id UUID UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  decision_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loan_applications_member_created
  ON loan_applications(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_applications_status_created
  ON loan_applications(status, created_at DESC);

CREATE TABLE IF NOT EXISTS operations_alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL,
  loan_application_id UUID REFERENCES loan_applications(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acknowledged','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES operators(id) ON DELETE RESTRICT,
  UNIQUE (alert_type, loan_application_id)
);

CREATE INDEX IF NOT EXISTS idx_operations_alerts_pending
  ON operations_alerts(status, created_at DESC);
