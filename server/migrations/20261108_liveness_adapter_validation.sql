-- Durable, country-specific evidence that a provider adapter was independently validated.
-- This table records approval; it does not itself enable biometric capture or execution.
CREATE TABLE IF NOT EXISTS avcu_liveness_adapter_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES avcu_identity_sources(id) ON DELETE RESTRICT,
  adapter_key TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  country_code CHAR(2) NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  validation_status TEXT NOT NULL DEFAULT 'pending_validation'
    CHECK (validation_status IN ('pending_validation','sandbox_validated','production_validated','suspended','expired')),
  validated_capabilities TEXT[] NOT NULL DEFAULT '{}',
  validation_suite_version TEXT,
  test_report_sha256 CHAR(64),
  evidence_reference TEXT,
  approval_reference TEXT,
  validated_by UUID REFERENCES operators(id),
  reviewed_by UUID REFERENCES operators(id),
  validated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  suspension_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (country_code ~ '^[A-Z]{2}$'),
  CHECK (adapter_key ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  CHECK (adapter_version <> ''),
  CHECK (test_report_sha256 IS NULL OR test_report_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (validated_by IS NULL OR reviewed_by IS NULL OR validated_by <> reviewed_by),
  CHECK (
    validation_status NOT IN ('sandbox_validated','production_validated')
    OR (
      validated_by IS NOT NULL AND reviewed_by IS NOT NULL
      AND validated_at IS NOT NULL AND expires_at IS NOT NULL
      AND approval_reference IS NOT NULL
      AND validation_suite_version IS NOT NULL
      AND test_report_sha256 IS NOT NULL
      AND cardinality(validated_capabilities)>0
    )
  ),
  CHECK (
    validation_status <> 'production_validated'
    OR (environment='production' AND validated_by<>reviewed_by)
  ),
  CHECK (validation_status <> 'sandbox_validated' OR environment='sandbox')
);
CREATE INDEX IF NOT EXISTS avcu_liveness_adapter_validation_lookup_idx
  ON avcu_liveness_adapter_validations(source_id,country_code,environment,expires_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS avcu_liveness_adapter_one_current_idx
  ON avcu_liveness_adapter_validations(source_id,country_code,environment)
  WHERE validation_status IN ('sandbox_validated','production_validated');
COMMENT ON TABLE avcu_liveness_adapter_validations IS
  'Two-person, country-specific adapter validation evidence. Approval records do not enable execution by themselves.';
