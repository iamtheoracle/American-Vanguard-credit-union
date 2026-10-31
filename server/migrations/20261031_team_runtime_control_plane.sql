-- Durable team runtime registry and operator control plane.
-- This migration creates control records only; it does not start workers or enable financial actions.
CREATE TABLE IF NOT EXISTS avcu_team_runtime (
  team_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'PROVISIONING'
    CHECK (lifecycle_state IN ('PROVISIONING','READY','ACTIVE','DEGRADED','PAUSED','DRAINING','QUARANTINED','DISABLED','FAILED')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  desired_state TEXT NOT NULL DEFAULT 'PAUSED'
    CHECK (desired_state IN ('READY','ACTIVE','PAUSED','DRAINING','QUARANTINED','DISABLED')),
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
  health JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS avcu_team_control_events (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES avcu_team_runtime(team_id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('operator','system')),
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  reason TEXT NOT NULL,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS avcu_team_control_events_team_created_idx
  ON avcu_team_control_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS avcu_team_runtime_state_idx
  ON avcu_team_runtime(lifecycle_state, desired_state);

-- Append-only control history. Updates/deletes are rejected even for normal application roles.
CREATE OR REPLACE FUNCTION avcu_reject_team_control_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'team control events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS avcu_team_control_events_immutable ON avcu_team_control_events;
CREATE TRIGGER avcu_team_control_events_immutable
  BEFORE UPDATE OR DELETE ON avcu_team_control_events
  FOR EACH ROW EXECUTE FUNCTION avcu_reject_team_control_event_mutation();
