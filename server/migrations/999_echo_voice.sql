-- ECHO AVCU: durable, consent-gated voice notification foundation.
-- Phone data is ciphertext only; encryption/decryption must use an approved KMS
-- adapter before a verified number can be stored or dispatched.
CREATE TABLE IF NOT EXISTS member_voice_preferences (
  member_id UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  phone_ciphertext TEXT,
  phone_fingerprint TEXT,
  phone_last4 TEXT,
  phone_verified_at TIMESTAMPTZ,
  voice_consent BOOLEAN NOT NULL DEFAULT FALSE,
  voice_consent_at TIMESTAMPTZ,
  voice_consent_source TEXT,
  voice_consent_revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT member_voice_last4 CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT member_voice_consent_has_verified_phone CHECK (
    NOT voice_consent OR (phone_ciphertext IS NOT NULL AND phone_fingerprint IS NOT NULL
      AND phone_verified_at IS NOT NULL AND voice_consent_at IS NOT NULL
      AND voice_consent_revoked_at IS NULL)
  )
);
CREATE TABLE IF NOT EXISTS echo_call_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  transaction_status TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suppressed'
    CHECK (status IN ('suppressed','pending','processing','submitted','delivered','failed','cancelled')),
  provider TEXT,
  provider_call_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_echo_outbox_due ON echo_call_outbox(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_echo_outbox_member ON echo_call_outbox(member_id, created_at DESC);
CREATE OR REPLACE FUNCTION avcu_enqueue_echo_transaction_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO echo_call_outbox (event_key, member_id, transaction_id, transaction_status, status)
    SELECT
      'transaction:' || NEW.id::text || ':member:' || a.member_id::text || ':status:' || NEW.status,
      a.member_id, NEW.id, NEW.status,
      CASE WHEN EXISTS (
        SELECT 1 FROM member_voice_preferences p
        WHERE p.member_id = a.member_id AND p.voice_consent = TRUE
          AND p.voice_consent_revoked_at IS NULL
          AND p.phone_verified_at IS NOT NULL AND p.phone_ciphertext IS NOT NULL
          AND p.phone_fingerprint IS NOT NULL
      ) THEN 'pending' ELSE 'suppressed' END
    FROM accounts a
    WHERE a.id IN (NEW.from_account_id, NEW.to_account_id)
    GROUP BY a.member_id
    ON CONFLICT (event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_echo_transaction_status ON transactions;
CREATE TRIGGER trg_echo_transaction_status
AFTER UPDATE OF status ON transactions
FOR EACH ROW EXECUTE FUNCTION avcu_enqueue_echo_transaction_status();
CREATE OR REPLACE FUNCTION avcu_cancel_echo_calls_on_consent_revocation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.voice_consent = TRUE AND (
    NEW.voice_consent = FALSE OR NEW.voice_consent_revoked_at IS NOT NULL
  ) THEN
    UPDATE echo_call_outbox SET status = 'cancelled', updated_at = now()
    WHERE member_id = NEW.member_id AND status IN ('pending','processing');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_echo_consent_revoked ON member_voice_preferences;
CREATE TRIGGER trg_echo_consent_revoked
AFTER UPDATE OF voice_consent, voice_consent_revoked_at
ON member_voice_preferences
FOR EACH ROW EXECUTE FUNCTION avcu_cancel_echo_calls_on_consent_revocation();
