CREATE TABLE IF NOT EXISTS product_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  product_type TEXT NOT NULL CHECK (product_type IN (
    'debit_card','credit_card','business_card',
    'personal_loan','home_loan','auto_loan','education_loan','business_loan'
  )),
  requested_amount_cents BIGINT CHECK (requested_amount_cents IS NULL OR requested_amount_cents > 0),
  purpose TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','needs_information','referred_to_partner','closed')),
  reviewed_by UUID REFERENCES operators(id),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_applications_member
  ON product_applications(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_applications_status
  ON product_applications(status, created_at ASC);
