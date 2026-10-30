-- Member-scoped, user-confirmed AI memory and transactional execution records.
CREATE TABLE IF NOT EXISTS ai_memory_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('preference','goal','accessibility','project_context','communication_style')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 3 AND 500),
  fingerprint TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS ai_memory_member_expiry_idx
  ON ai_memory_records (member_id, expires_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_memory_search_idx
  ON ai_memory_records USING GIN (to_tsvector('english', content)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_execution_idempotency (
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','succeeded','failed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ai_execution_created_idx ON ai_execution_idempotency (created_at);

CREATE TABLE IF NOT EXISTS ai_benchmark_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite TEXT NOT NULL,
  version TEXT NOT NULL,
  score NUMERIC(6,5) NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  passed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_benchmark_runs_created_idx ON ai_benchmark_runs (created_at DESC);
