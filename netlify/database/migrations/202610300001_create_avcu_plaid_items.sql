CREATE TABLE avcu_plaid_items (
  member_id text NOT NULL,
  item_id text NOT NULL,
  institution_id text,
  institution_name text NOT NULL,
  access_token_ciphertext text NOT NULL,
  accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id,item_id)
);
CREATE INDEX avcu_plaid_items_member_idx ON avcu_plaid_items (member_id,created_at DESC);
