-- Durable email notification outbox. Events are committed before delivery attempts.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  member_id UUID REFERENCES members(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  recipient TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  email_subject TEXT NOT NULL,
  email_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry','sent','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
  ON notification_outbox(status, next_attempt_at, id)
  WHERE status IN ('pending','retry');

CREATE INDEX IF NOT EXISTS idx_notification_outbox_member_created
  ON notification_outbox(member_id, created_at DESC);

-- A crashed worker may leave an event processing; stale claims can be retried.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_stale_claim
  ON notification_outbox(locked_at)
  WHERE status = 'processing';
