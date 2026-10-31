-- Provider-backed KYC case management. No raw biometric media is stored by this migration.
CREATE TABLE IF NOT EXISTS kyc_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  country_code CHAR(2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_consent'
    CHECK (status IN ('awaiting_consent','ready','provider_pending','verified','rejected','review_required','expired','provider_error','cancelled')),
  provider_key TEXT CHECK (provider_key IN ('trulioo','persona')),
  provider_transaction_id TEXT,
  provider_handoff_url TEXT,
  risk_level TEXT NOT NULL DEFAULT 'unknown' CHECK (risk_level IN ('unknown','low','medium','high')),
  assigned_reviewer_id UUID REFERENCES operators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(provider_key, provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_kyc_cases_member_created ON kyc_cases(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_cases_review_queue ON kyc_cases(status, created_at DESC);

CREATE TABLE IF NOT EXISTS kyc_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  notice_version TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('identity_verification','biometric_liveness','cross_border_processing')),
  consented BOOLEAN NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  notice_hash TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  UNIQUE(kyc_case_id, purpose, notice_version)
);
CREATE INDEX IF NOT EXISTS idx_kyc_consents_case ON kyc_consents(kyc_case_id);

CREATE TABLE IF NOT EXISTS kyc_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key TEXT NOT NULL CHECK (provider_key IN ('trulioo','persona')),
  provider_event_id TEXT NOT NULL,
  kyc_case_id UUID REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_verified_at TIMESTAMPTZ NOT NULL,
  payload_hash TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processed','quarantined','failed')),
  sanitized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider_key, provider_event_id)
);

CREATE TABLE IF NOT EXISTS kyc_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  provider_key TEXT NOT NULL CHECK (provider_key IN ('trulioo','persona')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','verified','rejected','review_required','expired','provider_error','cancelled')),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  checks_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_report_ref TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  normalized_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyc_results_case ON kyc_results(kyc_case_id, received_at DESC);

CREATE TABLE IF NOT EXISTS kyc_evidence_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL,
  storage_key TEXT,
  provider_reference TEXT,
  content_type TEXT,
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 CHAR(64),
  classification TEXT NOT NULL DEFAULT 'restricted'
    CHECK (classification IN ('restricted','highly_restricted','metadata_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_expires_at TIMESTAMPTZ,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  CHECK (storage_key IS NULL OR storage_key !~ '(^/|\.\.|://)')
);
CREATE INDEX IF NOT EXISTS idx_kyc_evidence_case ON kyc_evidence_objects(kyc_case_id);

CREATE TABLE IF NOT EXISTS kyc_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  reviewer_id UUID NOT NULL REFERENCES operators(id),
  decision TEXT NOT NULL CHECK (decision IN ('verified','rejected','review_required','request_information')),
  reason_code TEXT NOT NULL,
  notes_redacted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyc_reviews_case ON kyc_reviews(kyc_case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kyc_evidence_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_object_id UUID REFERENCES kyc_evidence_objects(id) ON DELETE RESTRICT,
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  actor_id UUID,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('list','view_metadata','preview','export','denied','delete','legal_hold')),
  reason TEXT NOT NULL,
  request_id TEXT,
  ip_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied'))
);
CREATE INDEX IF NOT EXISTS idx_kyc_access_case ON kyc_evidence_access_events(kyc_case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kyc_provider_routes (
  country_code CHAR(2) NOT NULL,
  check_type TEXT NOT NULL,
  primary_provider TEXT NOT NULL CHECK (primary_provider IN ('trulioo','persona')),
  fallback_provider TEXT CHECK (fallback_provider IN ('trulioo','persona')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by UUID REFERENCES operators(id),
  approval_ref TEXT,
  PRIMARY KEY(country_code, check_type)
);

COMMENT ON TABLE kyc_evidence_objects IS 'Metadata only until approved private encrypted evidence storage is configured. Never store raw biometric media in PostgreSQL.';
COMMENT ON TABLE kyc_provider_routes IS 'No country routes are enabled by default; each route requires documented compliance approval.';
