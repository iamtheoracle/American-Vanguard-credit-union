-- Durable, leased job queue with retry and dead-letter semantics.
CREATE TABLE IF NOT EXISTS avcu_service_identities (
  service_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES avcu_team_runtime(team_id),
  token_sha256 TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS avcu_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL REFERENCES avcu_team_runtime(team_id),
  service_id TEXT NOT NULL REFERENCES avcu_service_identities(service_id),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','succeeded','retry_wait','dead_letter','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(team_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS avcu_jobs_claim_idx ON avcu_jobs(team_id,status,available_at,created_at);
CREATE INDEX IF NOT EXISTS avcu_jobs_lease_idx ON avcu_jobs(status,lease_expires_at) WHERE status='leased';
CREATE TABLE IF NOT EXISTS avcu_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES avcu_jobs(id),
  event_type TEXT NOT NULL,
  worker_id TEXT,
  attempt INTEGER NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_job_events_job_idx ON avcu_job_events(job_id,id);
CREATE TABLE IF NOT EXISTS avcu_job_dead_letters (
  job_id UUID PRIMARY KEY REFERENCES avcu_jobs(id),
  team_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  final_error_code TEXT,
  attempts INTEGER NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS avcu_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES avcu_team_runtime(team_id),
  service_id TEXT NOT NULL REFERENCES avcu_service_identities(service_id),
  status TEXT NOT NULL CHECK (status IN ('starting','healthy','degraded','stopping','stopped')),
  active_job_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
