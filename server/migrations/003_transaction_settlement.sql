-- PostgreSQL returns BIGINT as text; the application converts explicitly, but
-- the settlement timestamp column was missing from the initial expansion.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
