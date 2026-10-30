ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS support_cases_member_idempotency_idx
  ON support_cases (member_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
