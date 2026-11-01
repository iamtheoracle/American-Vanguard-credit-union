-- AVCU liveness assurance orchestration. All controls are configured, but execution is gated
-- on independently validated and explicitly approved components for the member's country.
CREATE TABLE IF NOT EXISTS avcu_liveness_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id UUID NOT NULL REFERENCES avcu_identity_profiles(id) ON DELETE RESTRICT,
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  country_code CHAR(2) NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'blocked_unvalidated'
    CHECK (status IN ('blocked_unvalidated','created','in_progress','passed','failed','review_required','expired','cancelled')),
  source_id UUID REFERENCES avcu_identity_sources(id) ON DELETE RESTRICT,
  source_session_ref TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_liveness_case_idx ON avcu_liveness_sessions(kyc_case_id,created_at DESC);
CREATE TABLE IF NOT EXISTS avcu_liveness_check_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES avcu_liveness_sessions(id) ON DELETE RESTRICT,
  check_key TEXT NOT NULL CHECK (check_key IN (
    'active_challenge','passive_liveness','presentation_attack_detection','replay_detection',
    'camera_injection_detection','device_integrity','session_binding','face_match',
    'document_face_consistency','capture_quality','risk_fusion'
  )),
  result TEXT NOT NULL CHECK (result IN ('not_run','pass','fail','inconclusive','not_applicable')),
  source_id UUID REFERENCES avcu_identity_sources(id) ON DELETE RESTRICT,
  method TEXT NOT NULL,
  assurance_level TEXT NOT NULL DEFAULT 'unassessed'
    CHECK (assurance_level IN ('unassessed','low','moderate','high')),
  reason_code TEXT,
  evidence_ref TEXT,
  evaluated_at TIMESTAMPTZ,
  details_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_liveness_checks_session_idx ON avcu_liveness_check_events(session_id,created_at);
CREATE TABLE IF NOT EXISTS avcu_liveness_policy_versions (
  version TEXT PRIMARY KEY,
  country_code CHAR(2) NOT NULL,
  enabled_checks TEXT[] NOT NULL,
  minimum_assurance TEXT NOT NULL CHECK (minimum_assurance IN ('moderate','high')),
  approved_by UUID REFERENCES operators(id),
  approval_reference TEXT,
  effective_from TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approval_reference IS NOT NULL)
);
CREATE OR REPLACE FUNCTION avcu_prevent_liveness_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AVCU liveness check events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS avcu_liveness_events_append_only ON avcu_liveness_check_events;
CREATE TRIGGER avcu_liveness_events_append_only
  BEFORE UPDATE OR DELETE ON avcu_liveness_check_events
  FOR EACH ROW EXECUTE FUNCTION avcu_prevent_liveness_event_mutation();
COMMENT ON TABLE avcu_liveness_sessions IS 'AVCU-owned liveness orchestration record; never treat an unvalidated source as a pass.';
COMMENT ON TABLE avcu_liveness_check_events IS 'Append-only per-control liveness outcomes and assurance evidence; no raw biometric media.';
