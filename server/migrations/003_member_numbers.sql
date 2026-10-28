-- Numeric, user-facing member IDs are independent from email addresses.
CREATE SEQUENCE IF NOT EXISTS member_number_seq START WITH 1000000000;

ALTER TABLE members ADD COLUMN IF NOT EXISTS member_number BIGINT;

UPDATE members
SET member_number = nextval('member_number_seq')
WHERE member_number IS NULL;

SELECT setval(
  'member_number_seq',
  GREATEST(999999999, COALESCE((SELECT MAX(member_number) FROM members), 999999999)),
  true
);

ALTER TABLE members
  ALTER COLUMN member_number SET DEFAULT nextval('member_number_seq'),
  ALTER COLUMN member_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_member_number_unique
  ON members(member_number);
