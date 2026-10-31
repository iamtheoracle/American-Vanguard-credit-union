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

## Durable queue and worker implementation

The follow-on implementation adds:
- PostgreSQL jobs with idempotency keys, attempt limits, scheduled retries and explicit states.
- SKIP LOCKED leasing so multiple workers can safely claim different jobs.
- Lease tokens and owner checks for acknowledgements, failure reports and lease renewal.
- Lease-expiry recovery, bounded exponential backoff and dead-letter records.
- Append-only job events and per-team queue/worker health metrics.
- An independently runnable npm run worker process, scoped to one team and one service identity.
- A provider adapter boundary that requires HTTPS and an explicit hostname allowlist.

Worker configuration is injected at deployment time; do not commit values:
- DATABASE_URL
- AVCU_WORKER_TEAM
- AVCU_WORKER_SERVICE_ID (for example, travel-worker)
- AVCU_SERVICE_TOKEN_<SERVICE_ID> (minimum 32 characters; use a distinct randomly generated value for each identity)
- AVCU_WORKER_ID (optional stable instance identifier)

The API registers a service identity only when its corresponding token is supplied. The database stores a SHA-256 digest, not the plaintext token. A worker must match the registered service id, team and token digest before it starts. Jobs are additionally restricted to the service id and its declared capability.

## Secret handling and provider onboarding

The current adapter contract reads credentials injected into the process environment by the hosting platform. This is a secret-injection interface, not a built-in cloud secrets manager. Production deployment must use the hosting platform's encrypted secret store or an approved external secret manager, restrict secret access to the relevant service, rotate credentials, and prevent secrets from appearing in logs, build artifacts or CI output. Do not use committed .env files.

Each production provider must be onboarded individually:
1. Confirm the real provider account, legal entity, production agreement, approved scopes and permitted geography.
2. Configure the provider's exact HTTPS origin and hostname allowlist.
3. Inject a provider-specific credential only into the service that needs it.
4. Verify authentication, scope, webhook signature, replay protection, rate limits and provider status in a non-financial production-read-only test.
5. Record provider owner, data classification, retention, outage/fallback behaviour and revocation procedure.
6. Enable a customer-facing function only after end-to-end evidence and release approval.

No real provider is declared connected by this change. A configured URL or credential variable alone is not proof of a valid provider relationship or production access.

## Current activation status

- Queue schema and worker code: implemented in repository; database migration has not been applied in a live environment here.
- Worker process: independently runnable; no worker process has been deployed or started.
- Service identities: registration code is present; no production tokens have been provisioned.
- Provider adapters: secure generic boundary exists; no production provider is verified.
- Health visibility: operator endpoint exposes queue counts and worker heartbeats once migrations are applied.
- Deployment and end-to-end proof: blocked until a verified hosting target, production database, approved secret store, provider accounts and safe test environment are connected.