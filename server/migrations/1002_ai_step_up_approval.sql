-- Member re-authentication bound to the exact AI-generated transfer approval.
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS member_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS member_confirmation_hash TEXT,
  ADD COLUMN IF NOT EXISTS member_confirmation_method TEXT;

CREATE INDEX IF NOT EXISTS approvals_member_confirmation_idx
  ON approvals(member_id, member_confirmed_at)
  WHERE member_confirmed_at IS NOT NULL;
