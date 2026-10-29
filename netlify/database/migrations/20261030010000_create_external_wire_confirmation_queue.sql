-- External wire confirmation workflow only. This schema does not initiate wires or maintain balances.
CREATE TABLE IF NOT EXISTS external_wire_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_name TEXT NOT NULL CHECK (length(trim(sender_name)) BETWEEN 2 AND 160),
  beneficiary_name TEXT NOT NULL CHECK (length(trim(beneficiary_name)) BETWEEN 2 AND 160),
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 2 AND 120),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  destination_institution TEXT NOT NULL CHECK (length(trim(destination_institution)) BETWEEN 2 AND 160),
  external_reference TEXT NOT NULL CHECK (length(trim(external_reference)) BETWEEN 3 AND 160),
  status TEXT NOT NULL DEFAULT 'awaiting_evidence'
    CHECK (status IN ('awaiting_evidence','evidence_submitted','confirmed','rejected','escalated','returned_or_reversed')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_wire_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES external_wire_cases(id) ON DELETE RESTRICT,
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 8 AND 240),
  evidence_summary TEXT NOT NULL CHECK (length(trim(evidence_summary)) BETWEEN 10 AND 1000),
  submitted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_wire_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES external_wire_cases(id) ON DELETE RESTRICT,
  evidence_id UUID REFERENCES external_wire_evidence(id) ON DELETE RESTRICT,
  actor_identity_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('case_created','evidence_submitted','confirmed','rejected','escalated','returned_or_reversed')),
  note TEXT NOT NULL CHECK (length(trim(note)) >= 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS external_wire_cases_status_created_idx
  ON external_wire_cases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS external_wire_review_events_case_created_idx
  ON external_wire_review_events (case_id, created_at DESC);

-- Evidence and audit history are append-only for application roles.
CREATE OR REPLACE FUNCTION prevent_external_wire_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External wire evidence and review history are append-only';
END;
$$;
DROP TRIGGER IF EXISTS external_wire_evidence_no_update ON external_wire_evidence;
CREATE TRIGGER external_wire_evidence_no_update
  BEFORE UPDATE OR DELETE ON external_wire_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_external_wire_history_mutation();
DROP TRIGGER IF EXISTS external_wire_events_no_update ON external_wire_review_events;
CREATE TRIGGER external_wire_events_no_update
  BEFORE UPDATE OR DELETE ON external_wire_review_events
  FOR EACH ROW EXECUTE FUNCTION prevent_external_wire_history_mutation();
