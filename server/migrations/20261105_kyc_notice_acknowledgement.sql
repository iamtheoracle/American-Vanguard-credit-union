CREATE TABLE IF NOT EXISTS kyc_notice_acknowledgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_case_id UUID NOT NULL REFERENCES kyc_cases(id) ON DELETE RESTRICT,
  notice_version TEXT NOT NULL,
  notice_hash CHAR(64) NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  presented_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE(kyc_case_id,notice_version)
);
COMMENT ON TABLE kyc_notice_acknowledgements IS 'Records notice presentation and acknowledgement separately from consent and other lawful processing bases.';
