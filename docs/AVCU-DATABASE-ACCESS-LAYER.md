# AVCU backend access-layer implementation contract

## Immediate authentication boundary

- Keep the existing AVCU member/operator cookie sessions and their server-side database validation.
- Do not enable Supabase Auth or direct browser-to-Postgres access in this phase.
- Never trust a member ID, operator ID, role, capability, or tenant scope supplied by a browser.
- Browser clients must never receive the database URL, PostgreSQL credentials, Supabase service-role key, or worker credentials.

## Canonical operator roles

The server role registry is `server/operator-roles.js`. Roles are:

| Role | Intended access |
| --- | --- |
| operator | Assigned support work and limited operational queue visibility |
| management | Scoped case/application review, migration read access, team/queue visibility and audit read access |
| auditor | Read-only audit, migration and team status visibility; no writes, assignments, approvals, financial operations or team controls |
| super_admin | Operator administration and controlled operational configuration; not automatic authority for regulated financial actions |

The database constraint accepts `auditor` after migration `20261102_operator_auditor_role.sql`. The migration does not create or promote any operator. Existing account provisioning must still require an authorised super-admin workflow.

## Dedicated database access layer: required design

The next implementation must replace ad-hoc route-level SQL incrementally with a dedicated data-access boundary. It must provide:

1. Explicit repository methods for members, accounts, support, applications, notifications, audit, operators and worker queues.
2. Actor context sourced only from validated cookie sessions or verified worker identities.
3. Transaction-scoped identity context using `SET LOCAL` / `set_config(..., true)`; never session-level pooled connection state.
4. A non-bypass application database role for any future RLS-enforced path. The current `postgres` / `service_role` bypass path cannot be represented as RLS enforcement.
5. Separate member, operator, system and worker repository capabilities; deny by default.
6. Safe projections for member/operator data. Do not expose password hashes, session tokens, reset tokens, provider secrets, full card credentials or internal risk data.
7. Append-only audit events and explicit audit actor metadata.
8. Parameterised SQL only, bounded pagination, consistent transaction handling and structured error mapping.
9. No generic arbitrary-SQL method exposed to request handlers.
10. Tests proving actor context cannot leak between pooled requests or be forged by headers/body/query parameters.

## RLS rollout gate

RLS policies and grants must not be activated until the access layer uses a verified non-bypass role and all request paths have been migrated and tested. Enabling RLS while the application still depends on broad privileged access risks either breaking customer journeys or creating a false sense of protection.

Before the Supabase change, inventory every public table, view, function, trigger and default privilege; determine the exact connection role used by the API and workers; then test the migration against a disposable branch. No production grants, RLS, function permissions or credentials are changed by this branch.

## Required test gates

- Auditor can read only the explicitly allowed audit/migration/team views and cannot mutate anything.
- Operator cannot self-promote or access management/super-admin endpoints.
- Inactive operator and expired/revoked cookie sessions are rejected.
- Member identity is always derived from the validated session, not caller-supplied identifiers.
- Member A cannot read or mutate Member B's records.
- No member/operator path can mutate ledger balances or posted transaction outcomes except the separately approved backend workflow.
- Worker identity is bound to its exact service/team capability set.
- Audit history cannot be updated/deleted through application routes.
- API, notification worker and durable queue remain healthy after each staged migration.

## Implemented on this branch

- `server/db.js` now routes application queries through an AsyncLocalStorage request context when a validated member/operator request is active.
- Cookie authentication still validates the opaque token against `member_sessions` / `operator_sessions` before binding an actor.
- Each authenticated request receives one pinned PostgreSQL transaction with transaction-local `app.actor_type`, `app.actor_id`, and `app.actor_role` settings. The transaction commits when the response finishes and rolls back on an interrupted response.
- Nested application transactions use savepoints on the pinned request connection. Actor identity cannot be replaced by nested middleware.
- Dedicated repositories now own cookie session lookups/creation/revocation, member notifications and support-case reads/writes, operator queue summaries, and operator audit reads.
- Remaining route-level SQL is routed through the same request-scoped query boundary, but not all route SQL has yet been extracted into named repository methods.
- Test-only pool injection is gated behind `NODE_ENV=test`; it is not an application configuration path.

## Important limitation

The actor settings are trusted server context, not proof that RLS is active. The current application database connection may still use a privileged/bypass role. Do not create RLS policies that trust these settings until the exact runtime database role, role grants, SQL injection boundary, and transaction behavior have been independently reviewed. Production Supabase has not been changed.
