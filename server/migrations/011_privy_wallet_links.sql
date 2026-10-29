-- Privy identity and externally linked wallet references.
-- This stores public wallet addresses only; never store access tokens or keys.
CREATE TABLE IF NOT EXISTS member_privy_links (
  member_id UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  privy_user_id TEXT NOT NULL UNIQUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_privy_wallets (
  id BIGSERIAL PRIMARY KEY,
  member_id UUID NOT NULL REFERENCES member_privy_links(member_id) ON DELETE CASCADE,
  privy_user_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  chain_type TEXT NOT NULL DEFAULT 'unknown',
  wallet_client_type TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_member_privy_wallets_member
  ON member_privy_wallets(member_id);
