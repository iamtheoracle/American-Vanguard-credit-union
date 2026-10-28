-- AVCU membership tiers and auditable email delivery tracking.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS membership_tier TEXT NOT NULL DEFAULT 'new_member'
    CHECK (membership_tier IN ('new_member','active_member','established_member','priority_service','review_required')),
  ADD COLUMN IF NOT EXISTS tier_override TEXT
    CHECK (tier_override IS NULL OR tier_override IN ('new_member','active_member','established_member','priority_service','review_required')),
  ADD COLUMN IF NOT EXISTS tier_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS tier_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS membership_tier_history (
  id BIGSERIAL PRIMARY KEY,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  previous_tier TEXT,
  new_tier TEXT NOT NULL CHECK (new_tier IN ('new_member','active_member','established_member','priority_service','review_required')),
  reason TEXT NOT NULL,
  changed_by_type TEXT NOT NULL DEFAULT 'system' CHECK (changed_by_type IN ('system','operator')),
  changed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tier_history_member ON membership_tier_history(member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_delivery_log (
  id BIGSERIAL PRIMARY KEY,
  member_id UUID REFERENCES members(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_created ON email_delivery_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_status ON email_delivery_log(status, created_at DESC);
