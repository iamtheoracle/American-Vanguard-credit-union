-- Usernames are separate from the generated numeric member number and email address.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS username TEXT
  CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,24}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username_unique
  ON members(username)
  WHERE username IS NOT NULL;
