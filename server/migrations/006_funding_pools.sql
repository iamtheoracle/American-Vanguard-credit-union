-- Funding pool catalogue and verified contribution records. Participation is disabled by default.
CREATE TABLE IF NOT EXISTS funding_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 120),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 10 AND 3000),
  target_amount_cents BIGINT NOT NULL CHECK (target_amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  eligibility_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  fees_and_terms TEXT,
  risk_disclosure TEXT NOT NULL,
  return_assumptions TEXT,
  calculation_methodology TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  contributions_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS funding_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_pool_id UUID NOT NULL REFERENCES funding_pools(id) ON DELETE RESTRICT,
  member_id UUID REFERENCES members(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','reversed','failed')),
  provider_reference TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  CHECK (status <> 'verified' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_funding_pools_published
  ON funding_pools(status, opens_at, closes_at);
CREATE INDEX IF NOT EXISTS idx_funding_contributions_verified
  ON funding_contributions(funding_pool_id, currency, status)
  WHERE status = 'verified';
