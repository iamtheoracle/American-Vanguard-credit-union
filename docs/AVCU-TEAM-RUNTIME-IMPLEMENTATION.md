# AVCU independent team runtime and operator control plane

## What this change establishes

- A durable PostgreSQL registry for independently identified service teams.
- Explicit lifecycle states and a separate desired state, so an operator command is not falsely reported as a worker acknowledgement.
- A super-admin-only control endpoint and read-only team status endpoint behind the existing operator session middleware.
- Append-only control events, row locking, version increments and transition validation.
- A startup registration step that creates missing team definitions without overwriting existing configuration.
- A health response that includes the registered teams.

## Initial team boundaries

Member Experience; Identity & Trust; Payments & Ledger; Cards & Lending; Communications; Travel; AI Orchestration; Risk & Compliance; Operations & Reliability.

Each team has a separate identity, description, declared capabilities, provider-binding slot, health document and lifecycle record. This is the control-plane registry; it does not claim that nine independent worker processes have been deployed.

## Lifecycle and control semantics

`lifecycle_state` is the last observed state. `desired_state` is the operator's requested state. The API records the desired state and an immutable control event; only a worker heartbeat may report observed readiness/health. A command being accepted is not proof that a worker paused, drained or restarted.

Control route:
- `GET /api/operator/teams` — operator/auditor read access.
- `POST /api/operator/teams/:teamId/control` — super-admin only; requires `desiredState` and a reason of at least eight characters.

## Important implementation boundary

This commit establishes the database-backed control-plane foundation, not full autonomous execution. No worker fleet, queue consumer, deployment controller, secret manager, provider credential, external API connection or production hosting is provisioned by this change. The provider-binding JSON is an inventory/configuration slot, not a live integration.

Before activating teams, implement and test:
1. Durable queue dispatch and independently deployed workers with scoped service identities.
2. Worker command polling/acknowledgement, leases, heartbeats and stale-worker detection.
3. Signed internal service-to-service authentication and replay protection.
4. Per-team permissions, resource quotas, concurrency limits and network egress allowlists.
5. Retry budgets, idempotency, dead-letter handling, circuit breakers and controlled failover.
6. Central metrics, traces, alerting, incident runbooks, backup/restore and disaster recovery.
7. Operator approval and two-person release gates for high-impact configuration.

Financial, identity-proofing, card issuance, lending decisions, account opening and money movement remain disabled until institutional authority, applicable approvals, production partner access, security/compliance review and explicit release approval are evidenced. No live credentials are stored in this repository.
