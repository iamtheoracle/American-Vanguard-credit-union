# AVCU team autonomy, operator control plane and API architecture

**Status:** Architecture specification for implementation and review  
**Scope:** Internal platform architecture; not production authorisation.

## 1. Core requirement

Every functional team/service must be independently deployable and able to execute its approved responsibilities without a human operator continuously present or an operator dashboard being open. Every team must remain governable by a secure central control plane. Every team must have a standard API integration boundary so existing approved providers can be connected, replaced, or used as fallbacks without rebuilding the team.

These are complementary capabilities, not three competing ways to bypass controls. A team is operational only when its own runtime, permissions, policy and required dependencies are healthy.

## 2. Three cooperating layers

### A. Independent team runtime

Each team is a bounded service/worker with:
- A single documented mission, owner, service boundary and service-level objectives.
- Its own deployment unit, configuration namespace, health/readiness checks and versioned release.
- A durable job queue or event subscription, idempotent handlers, retry limits, dead-letter/quarantine handling and replay controls.
- A scoped service identity and least-privilege access to data and tools.
- Team-specific policy, budget/rate limits, timeout limits, concurrency limits and dependency declarations.
- Structured logs, metrics, traces, audit events and a health heartbeat.
- A documented degraded mode and recovery procedure.

Teams must not share privileged credentials or rely on another team's in-memory state. They communicate through versioned APIs/events and explicit contracts. A failed team should not cascade into unrelated teams; circuit breakers, bounded queues and dependency timeouts must isolate failures.

### B. Private operator control plane

The operator control plane is a backend governance service, not a customer-facing page. The dashboard is only one optional interface to it. The control plane must remain usable through authenticated administrative APIs and approved operational tooling even when no operator UI is exposed.

For every team, authorised operators can:
- Inspect status, health, queue depth, errors, dependency health, current version and recent audit events.
- Enable, pause, drain, resume, quarantine or disable the team.
- Change approved configuration, feature flags, provider routing and resource limits.
- Revoke or rotate a team identity and suspend individual tools or capabilities.
- Require human approval for specified action classes.
- Trigger a controlled retry/replay or rollback, with reason and audit record.
- Set maintenance windows, emergency stop and recovery mode.

Controls must be enforced server-side on every job/action, not only hidden in the UI. Customer identities must never inherit operator powers. Operator access requires strong authentication, role-based and attribute-based authorization, least privilege, short-lived sessions, step-up authentication for sensitive actions, immutable audit history and separation of duties. High-impact changes require dual control where policy requires it.

An operator UI being unavailable must not stop already-authorised low-risk jobs. Conversely, the absence of a visible UI must never make a team ungovernable: backend policy, kill switches, quotas, revocation and audit must continue to operate.

### C. API and provider integration layer

Every team receives a provider-neutral adapter interface. Provider implementations sit behind that interface, not inside core business logic.

Each integration must declare:
- Provider and product identity; environment (mock, sandbox, staging, production).
- Supported capabilities and explicit unsupported capabilities.
- Authentication method and required scopes.
- Credential reference/secret-manager key name only; never secret values in code, logs or docs.
- Request/response schemas, version, timeout, retry and idempotency behavior.
- Webhook verification requirements, replay protection and event mapping.
- Rate limits, cost controls, data residency and retention constraints.
- Health checks, contract tests, last successful verification and evidence owner/date.

Support multiple approved adapters per capability. Routing policy can select primary, secondary or manual handoff based on capability, jurisdiction, customer eligibility, provider health, price and operator policy. Failover is allowed only when the alternate provider is approved for the same operation and jurisdiction. Do not automatically retry non-idempotent financial actions or switch providers after an ambiguous settlement result; reconcile first.

The API layer must distinguish:
- Provider account exists.
- Developer/API access exists.
- Production scope and agreement are approved.
- Credentials are configured in the correct environment.
- Integration tests pass.
- Live production operation is independently verified.

No one status implies the next.

## 3. Team contract and lifecycle

Every team must publish a machine-readable manifest with:
- team_id, name, mission, owner, criticality and version;
- permitted inputs, outputs, data classifications and event subscriptions;
- required capabilities and provider adapter contracts;
- action risk classes and approval policy;
- allowed jurisdictions and customer types;
- resource budgets, retry policy, health probes and runbook;
- operator controls supported and audit event schema.

Lifecycle states: PROVISIONING, READY, ACTIVE, DEGRADED, PAUSED, DRAINING, QUARANTINED, DISABLED and FAILED. State transitions must be authorised and audited. A team cannot mark itself ACTIVE if mandatory policy, identity, dependency or health checks fail.

## 4. Work autonomy and approval boundaries

Use risk-tiered autonomy:
- **Tier 0 — Read/observe:** health checks, retrieval of permitted data, classification and reporting.
- **Tier 1 — Reversible low-risk work:** draft, prepare, validate, notify with consent, queue and route requests within limits.
- **Tier 2 — Sensitive or externally consequential:** require policy checks and, where configured, member confirmation or operator approval.
- **Tier 3 — Regulated/high-impact:** financial posting, money movement, account opening, card issuance, credit decisions, loan approval/funding, identity overrides, production credential changes and data export require explicit authorised controls, segregation of duties and completed compliance/provider gates. Autonomous AI/team execution alone is never sufficient authority.

If the policy/control service is unavailable, fail closed for Tier 2/3 actions. Tier 0/1 may continue only if their cached policy is signed, unexpired and explicitly permits offline operation. No team may invent authority from a timeout.

## 5. Resilience and independence tests

Acceptance tests must prove:
1. Each team can deploy, start, stop, scale and roll back independently.
2. Closing or disabling the operator dashboard does not stop permitted background work.
3. The backend operator API can pause, resume, quarantine and revoke a team without the dashboard.
4. A team cannot exceed its own data/tool permissions or invoke another team's privileged operations.
5. One team's outage, queue backlog or malformed event does not cascade across the platform.
6. Duplicate events and retries do not duplicate side effects.
7. Provider outage triggers only approved fallback or a clear degraded/manual-handoff state.
8. Provider failover never changes the meaning, jurisdiction, pricing disclosure or risk of an operation.
9. Policy-service loss blocks sensitive actions and preserves an auditable reason.
10. Every operator action, provider change, permission denial and high-impact job is attributable and auditable.
11. Secret scanning confirms credentials are absent from source, test fixtures, logs and artifacts.
12. Recovery, replay, backup restoration and disaster scenarios are tested.

## 6. Suggested platform teams

Create separate bounded teams/services only where their data and operational boundaries justify it. Initial candidates:
- Member identity and access.
- Membership and eligibility.
- Accounts and ledger.
- Payments and transfers.
- Cards.
- Loans and credit education.
- Fraud, risk and compliance.
- Notifications and communications.
- Customer support and case management.
- Travel discovery and trip services.
- Provider/API integrations.
- Platform operations, observability and audit.

A team may contain multiple workers, but it must have one accountable owner and a single policy boundary. Shared capabilities (identity, policy, audit, secrets, event bus) are platform services, not hidden shared admin credentials.

## 7. Implementation sequence

1. Inventory existing services, routes, queues, workers, role checks, provider adapters and migrations on the selected integration branch.
2. Define team manifests and map current modules to bounded team ownership; do not create duplicate services just to satisfy naming.
3. Implement the shared team runtime contract: identity, policy check, job envelope, idempotency, health, audit and lifecycle.
4. Implement the private operator control API and server-enforced kill/pause/revoke controls; dashboard remains optional.
5. Standardise provider adapter contracts and provider registry; migrate existing adapters incrementally.
6. Add fault-injection, permission-boundary, failover and recovery tests.
7. Run migrations and tests in disposable PostgreSQL/staging; review security and operational evidence.
8. Keep all live financial operations disabled until institution authority, provider production access, regulatory/compliance review and explicit release approval are verified.

## 8. Non-goals and safeguards

- This design does not create an actual staffed team or prove a provider account/API is available.
- It does not grant autonomous teams authority to move money or make regulated decisions.
- It does not expose internal operator controls to customers.
- It does not allow API keys to be pasted into source code, client bundles or chat.
- It does not equate an API endpoint existing with a provider integration being production-ready.
- It does not authorise deployment under an institution's identity without documented authority.

**Acceptance definition:** Every team can perform its permitted work independently, can be governed and stopped through backend operator controls without a visible operator UI, and can use approved API adapters through a stable provider-neutral contract. All three capabilities must be tested before the platform is considered operationally complete.
