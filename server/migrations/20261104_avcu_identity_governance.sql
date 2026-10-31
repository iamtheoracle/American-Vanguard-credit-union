-- AVCU-owned identity governance and accountable information disclosure.
-- This schema is the system of record; external providers are optional evidence sources.
CREATE TABLE IF NOT EXISTS avcu_identity_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL UNIQUE REFERENCES members(id) ON DELETE RESTRICT,
  lifecycle_status TEXT NOT NULL DEFAULT 'pending' CHECK (lifecycle_status IN ('pending','active','restricted','closed')),
  country_code CHAR(2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS avcu_identity_verification_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  session_type TEXT NOT NULL CHECK (session_type IN ('document','identity_consistency','liveness','source_corroboration','manual_review')),
  country_code CHAR(2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','in_progress','passed','failed','review_required','expired','cancelled')),
  initiated_by_type TEXT NOT NULL CHECK (initiated_by_type IN ('member','operator','system')),
  initiated_by_id UUID,
  policy_version TEXT NOT NULL,
  source_matrix_version TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS avcu_identity_sessions_profile_idx ON avcu_identity_verification_sessions(identity_profile_id,started_at DESC);
CREATE TABLE IF NOT EXISTS avcu_identity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES avcu_identity_verification_sessions(id) ON DELETE RESTRICT,
  check_type TEXT NOT NULL CHECK (check_type IN ('document_integrity','document_expiry','field_consistency','tamper_signal','liveness_attestation','face_match_attestation','source_corroboration','human_review')),
  result TEXT NOT NULL CHECK (result IN ('pass','fail','inconclusive','not_applicable')),
  method TEXT NOT NULL,
  source_id UUID,
  assurance_level TEXT NOT NULL DEFAULT 'unassessed' CHECK (assurance_level IN ('unassessed','low','moderate','high')),
  evidence_ref TEXT,
  reason_code TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details_redacted JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS avcu_identity_checks_session_idx ON avcu_identity_checks(session_id,evaluated_at DESC);
CREATE TABLE IF NOT EXISTS avcu_identity_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES avcu_identity_verification_sessions(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('verified','rejected','review_required','incomplete')),
  decision_basis JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL,
  decided_by_type TEXT NOT NULL CHECK (decided_by_type IN ('system','operator')),
  decided_by_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_identity_decisions_profile_idx ON avcu_identity_decisions(identity_profile_id,created_at DESC);
CREATE TABLE IF NOT EXISTS avcu_identity_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('avcu_internal','government_authoritative','regulated_registry','document_technology','biometric_attestation','external_provider')),
  display_name TEXT NOT NULL,
  country_codes CHAR(2)[] NOT NULL DEFAULT '{}',
  supported_checks TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','testing','approved','suspended','retired')),
  approval_reference TEXT,
  approved_by UUID REFERENCES operators(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (approval_reference IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS avcu_identity_evidence_manifest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  session_id UUID REFERENCES avcu_identity_verification_sessions(id) ON DELETE RESTRICT,
  evidence_category TEXT NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'unconfigured',
  private_object_key TEXT,
  encryption_key_reference TEXT,
  sha256 CHAR(64),
  media_type TEXT,
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
  classification TEXT NOT NULL DEFAULT 'highly_restricted' CHECK (classification IN ('restricted','highly_restricted','metadata_only')),
  source_attestation JSONB NOT NULL DEFAULT '{}'::jsonb,
  retention_expires_at TIMESTAMPTZ,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (private_object_key IS NULL OR private_object_key !~ '(^/|\.\.|://)'),
  CHECK (encryption_key_reference IS NULL OR encryption_key_reference !~ '(^/|\.\.|://)')
);
CREATE INDEX IF NOT EXISTS avcu_identity_evidence_profile_idx ON avcu_identity_evidence_manifest(identity_profile_id,created_at DESC);
CREATE TABLE IF NOT EXISTS avcu_identity_case_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  assigned_by UUID NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('review','evidence_metadata','disclosure_prepare')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS avcu_identity_assignments_active_idx ON avcu_identity_case_assignments(operator_id,identity_profile_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS avcu_identity_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('operator','service','external_recipient')),
  grantee_id TEXT NOT NULL,
  allowed_fields TEXT[] NOT NULL,
  purpose TEXT NOT NULL,
  legal_basis TEXT NOT NULL,
  authority_reference TEXT,
  granted_by UUID NOT NULL REFERENCES operators(id),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(allowed_fields) > 0),
  CHECK (expires_at > valid_from)
);
CREATE TABLE IF NOT EXISTS avcu_data_disclosure_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  recipient_legal_entity TEXT NOT NULL,
  recipient_person TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  recipient_identifier TEXT NOT NULL,
  purpose TEXT NOT NULL,
  legal_basis TEXT NOT NULL CHECK (legal_basis IN ('legal_obligation','contract','legitimate_interests','consent','vital_interests','public_task','other_approved_basis')),
  authority_reference TEXT,
  consent_record_id UUID,
  channel TEXT NOT NULL CHECK (channel IN ('secure_api','secure_portal','encrypted_transfer','regulated_network','other_approved_channel')),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','denied','released','expired','revoked','deletion_requested','deletion_confirmed')),
  requested_by UUID NOT NULL REFERENCES operators(id),
  approved_by UUID REFERENCES operators(id),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  transfer_receipt_hash CHAR(64),
  downstream_deletion_due_at TIMESTAMPTZ,
  downstream_deletion_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status NOT IN ('approved','released') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS avcu_disclosure_profile_idx ON avcu_data_disclosure_requests(identity_profile_id,created_at DESC);
CREATE TABLE IF NOT EXISTS avcu_data_disclosure_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_request_id UUID NOT NULL REFERENCES avcu_data_disclosure_requests(id) ON DELETE RESTRICT,
  field_key TEXT NOT NULL,
  data_category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(disclosure_request_id,field_key)
);
CREATE TABLE IF NOT EXISTS avcu_data_disclosure_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_request_id UUID NOT NULL REFERENCES avcu_data_disclosure_requests(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('requested','approved','denied','released','revoked','expired','deletion_requested','deletion_confirmed','accessed')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('member','operator','system','recipient')),
  actor_id TEXT,
  reason TEXT NOT NULL,
  channel TEXT,
  recipient_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  fields_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  authority_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt_hash CHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_disclosure_events_request_idx ON avcu_data_disclosure_events(disclosure_request_id,occurred_at);
CREATE TABLE IF NOT EXISTS avcu_identity_retrieval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  evidence_id UUID REFERENCES avcu_identity_evidence_manifest(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('member','operator','service')),
  actor_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('list','metadata_view','preview','retrieve','export','denied','delete','legal_hold')),
  purpose TEXT NOT NULL,
  case_reference TEXT,
  authentication_level TEXT NOT NULL DEFAULT 'session',
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied')),
  request_id TEXT,
  ip_hash CHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_identity_retrieval_profile_idx ON avcu_identity_retrieval_events(identity_profile_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS avcu_identity_retention_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id UUID NOT NULL REFERENCES avcu_identity_evidence_manifest(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('scheduled','deleted','blocked_by_legal_hold','legal_hold_applied','legal_hold_released')),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE avcu_identity_profiles IS 'AVCU-owned identity record. External verification sources are evidence inputs only, never the system of record.';
COMMENT ON TABLE avcu_identity_evidence_manifest IS 'Evidence metadata only; object bytes must live in an approved private encrypted vault, never PostgreSQL.';
COMMENT ON TABLE avcu_data_disclosure_events IS 'Append-only accountability ledger of disclosure requests, approvals, releases, revocations and deletion confirmations.';
