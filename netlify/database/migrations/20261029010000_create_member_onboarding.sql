CREATE TABLE IF NOT EXISTS member_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','resubmission')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES member_applications(id) ON DELETE CASCADE,
  identity_user_id TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'membership_identity',
  applicant_statement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','resubmission')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verification_requests_status_created_idx
  ON verification_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_requests_user_created_idx
  ON verification_requests (identity_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS verification_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES member_applications(id) ON DELETE CASCADE,
  verification_request_id UUID NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  reviewer_identity_user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','resubmission')),
  note TEXT NOT NULL CHECK (length(trim(note)) >= 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verification_review_events_request_created_idx
  ON verification_review_events (verification_request_id, created_at DESC);