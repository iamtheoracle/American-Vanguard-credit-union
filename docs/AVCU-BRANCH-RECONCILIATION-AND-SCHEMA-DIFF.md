# AVCU branch reconciliation and target-schema difference inventory

**Review date:** 2026-10-31  
**Repository:** `iamtheoracle/American-Vanguard-credit-union`  
**Review baseline:** PR #24 head `8bd7f278ee575cbd5d65dc5c7de3c539ede3cad5`; PR #23 base `5f83a0e284afb955d779f23d5e72565d95bbcace`.  
**Scope:** Read-only repository inspection plus this documentation commit. No merge, deployment, production database change, provider configuration, or financial operation was performed.

## 1. Executive decision

Do not select `main` as the implementation baseline: the reviewed development work is substantially ahead of it. Do not merge all feature PRs together or apply every migration. Multiple overlapping architectures and schema families must first be reconciled.

**Recommended working integration spine:** PR #23 followed by PR #24. PR #24 explicitly builds on PR #23 and adds request-scoped access context, named repositories, an operator auditor role and disposable RLS tests. This is a review baseline, not a release candidate or production-approved baseline.

**Feature candidates to reconcile into that spine:**
- PR #18 account-history workspace.
- PR #21 card/loan application centre, explicitly stacked on PR #18.
- PR #20 provider-independent banking, jurisdiction controls, controlled journals and provider-event lifecycle.
- PR #16 asset-aware double-entry ledger, after resolving overlap with PR #20's journal model.
- PR #19 Supabase Auth identity mapping only after an explicit decision about replacing or bridging existing cookie-session authentication. PR #24 explicitly retains cookie sessions for this phase.
- PR #17 public demo retirement/identity correction, subject to correcting the proposed institution name and verifying public claims.
- PR #22 replacement plan as a planning source, updated against the reconciled code.

PRs #16–#24 listed in this report were observed as open draft PRs during inspection. None was treated as merged or deployed.

## 2. Pull-request dependency and divergence inventory

| PR | Purpose | Observed base relationship | Reconciliation decision |
|---|---|---|---|
| #16 | Asset-aware double-entry ledger | Separate base SHA `7a41a859...` | Candidate ledger design; compare with #20 before choosing canonical model |
| #17 | Remove fabricated demo; identity/public-page correction | Separate base SHA `c2b2b9a4...` | Strong safety direction; proposed name and institutional statements require correction/verification |
| #18 | Recorded account history | Based on main SHA `17736908...` | Candidate; preserve read-only scope and missing-data disclosures |
| #19 | Supabase member-auth foundation | Based on main SHA `17736908...` | Conflicts architecturally with #24 cookie-session direction; do not activate both without an identity design |
| #20 | Provider-independent banking foundation | Based on main SHA `17736908...` | High-value candidate; migrations/functions need full review and disposable PostgreSQL tests |
| #21 | Homepage, card and loan request flows | Stacked on #18 head `dbb091d1...` | Keep dependency explicit; test with #18, not as a standalone UI cherry-pick |
| #22 | Replacement platform plan | Based on main SHA `17736908...` | Update after code reconciliation |
| #23 | Team runtime and durable queue | Separate base SHA `7a41a859...` | Candidate runtime foundation; no production worker/provider execution established |
| #24 | Access layer, auditor role and disposable RLS tests | Stacked on #23 head `5f83a0e2...` | Recommended security/integration spine for continued review; not proof of production RLS |

### Main-branch divergence

The observed comparison of `main` to `feat/avcu-integration-hardening` returned 232 commits ahead, 1 behind, status `diverged`. The advanced branch adds an Express/PostgreSQL API, member/operator portals, migrations, integrations, tests and CI. Its README still describes the root page as a local-storage simulator, with API-connected member and operator portals on separate pages. This is not yet one unified customer journey.

## 3. Architecture conflicts and material findings

### 3.1 Authentication: PR #19 versus PR #24

PR #19 introduces Supabase Auth identity mapping via `public.member_profiles` referencing `auth.users`, with member self-read and no client write policy. Its documentation says it does not connect/deploy a project, create users or send email.

PR #24 explicitly preserves opaque cookie sessions validated server-side against `member_sessions` and `operator_sessions`, then binds a request-scoped actor context.

**Decision:** retain PR #24 cookie-session authentication for the immediate integration spine. Treat PR #19 as an alternative/future identity bridge, not an automatically additive migration. Before any identity cutover, specify account linking, session revocation, recovery, MFA/step-up, member provisioning, operator identity and migration/rollback.

### 3.2 Banking and ledger: PR #16 versus PR #20

PR #16 adds server migration `012_asset_aware_double_entry_ledger.sql`, including `business_profiles`, `business_memberships`, `financial_accounts`, `journal_transactions` and `journal_entries`, with asset-aware balancing and journal controls. It leaves legacy `accounts`, `transactions` and `ledger_entries` untouched.

PR #20 separately adds five Supabase migrations for member identity, banking foundation, jurisdiction controls, ledger posting controls and provider-event worker lifecycle. Its described scope includes financial-account/journal entities, jurisdiction/capability registry, fail-closed provider routing, controlled posting/reversal, provider-event inbox, leases/retries/quarantine and narrow server-side functions.

**Decision:** do not apply both ledger models without a mapping and canonical-model decision. Map legacy ledger, PR #16 and PR #20 entities/fields/lifecycles. Decide which is authoritative for each lifecycle; avoid dual-write and duplicate balance authority.

### 3.3 Migration systems are not one release train

The integration branch has `server/migrations/*.sql` applied by the Express migration runner. PR #20 introduces a separate `supabase/migrations/*.sql` family. Their presence in branches does not establish that they were applied to the same database or are compatible with the live Supabase project.

The previously inspected live Supabase project had 37 public tables, all RLS-disabled, zero policies and broad anon/authenticated grants. These live findings are separate from unmerged migration files.

**Decision:** document migration ownership per target database; test ordering, replay and rollback on a disposable database. Never infer that a Git migration has run in production.

### 3.4 Access layer: useful but incomplete

PR #24 `server/db.js` uses AsyncLocalStorage, pins authenticated request queries to one PostgreSQL transaction, sets transaction-local actor settings, uses savepoints for nested transactions and commits before ending the response. Its own access-layer document says actor settings do not prove RLS is active and a non-bypass application role is still required.

Open work:
- The configured runtime database role has not been independently evidenced as non-superuser and NOBYPASSRLS.
- Queries outside a validated member/operator request context can still use the pool directly.
- Worker/system actor context and worker database access need a separate verified binding and role model.
- RLS tests cover disposable fixture tables, not all production tables or actual application routes.
- Actor GUCs are trustworthy only if set exclusively by trusted server code on the pinned transaction and no untrusted SQL path can modify them.

**Decision:** do not enable production RLS until actual API/worker connection roles, grants, bypass flags, all query paths, functions and actor context are verified.

### 3.5 Institution identity and naming

Reviewed repository materials use “American Vantoris Credit Union”, “America Vanguard Credit Union” and “American Vanguard Credit Union”. These conflict with the institution identity specified for this project: Atchison Village Credit Union.

**Decision:** no customer-facing brand, legal disclosure, product/rate statement, institution address or official-service claim should be published until authorised identity and authority are confirmed. Repository copy remains unapproved draft content.

### 3.6 Homepage and product-application journey

PR #21 adds card product discovery, loan pathways, member-scoped application records and operator review. Its description correctly says requests do not issue cards or approve/fund loans. It is stacked on PR #18.

The advanced README still describes a local-storage root demo and separate member/operator portals. PR #21 does not prove a complete public-to-member-to-operator-to-provider journey.

**Decision:** preserve the application-centre work, but unify it with authenticated member home, status tracking, document requests, disclosures, support and operator decisions only after end-to-end route/data tests.

## 4. Target-schema difference inventory

This is a **known-difference inventory**, not a claim that every target migration has been applied.

| Schema family | Existing / candidate entities | Required reconciliation |
|---|---|---|
| Core identity | `members`, `member_sessions`, `password_reset_tokens`, `membership_tier_history`; PR #19 `member_profiles` | Decide cookie identity vs Supabase Auth mapping; map member IDs and status lifecycle |
| Legacy banking | `accounts`, `transactions`, `ledger_entries` | Document authoritative balance and transaction status source |
| Asset-aware ledger (#16) | `business_profiles`, `business_memberships`, `financial_accounts`, `journal_transactions`, `journal_entries` | Reconcile business ownership, asset and custody domain with #20 |
| Provider-independent banking (#20) | Financial-account/journal, provider event/outbox/control entities in Supabase migrations | Inspect full DDL, functions, triggers, indexes, constraints, grants and ownership; map to #16 and legacy ledger |
| Jurisdiction/product controls (#20) | Country/jurisdiction, entity/customer-type/capability and provider-routing controls | Verify no country/provider is enabled by default; preserve fail-closed defaults |
| Product applications (#21) | `product_applications` and review/status fields | Exact DDL still needs extraction; verify ownership, review, documents and no issuance/underwriting implication |
| Team runtime (#23) | `avcu_team_runtime`, `avcu_team_control_events`, `avcu_service_identities`, `avcu_jobs`, `avcu_job_events`, `avcu_job_dead_letters`, `avcu_worker_heartbeats` | Verify worker/service identity, team scope, payload/result confidentiality, lease ownership and audit |
| Access control (#24) | Operator role constraint including `auditor`; repositories/access context | App roles and PostgreSQL roles are distinct; specify both |
| Communications | `notifications`, `notification_outbox`, `email_delivery_log` | At-least-once email semantics, sensitive content, retry/idempotency and recipient access |
| Support/oversight | `support_cases`, `case_messages`, `audit_events`, `operations_alerts` | Member/case ownership, scoped operator access, append-only audit and redaction |
| Integrations/AI/Privy | `webhook_events`, `idempotency_keys`, `integration_health`, `ai_tasks`, `member_privy_links`, `member_privy_wallets` | Provider payload confidentiality, wallet identifiers, AI task content, webhook verification and service-only access |

### Exact catalog extraction still required

For every existing and proposed table, extract:
1. Columns, types, nullability, defaults, generated expressions and comments.
2. Primary, unique, check and foreign-key constraints including delete/update actions.
3. Index definitions, predicates, included columns and uniqueness.
4. RLS enabled/forced state and all policies including command, role, USING and WITH CHECK.
5. Table, sequence, schema and function privileges for PUBLIC, anon, authenticated, service_role, postgres, app roles and worker roles.
6. Function signature, language, SECURITY DEFINER status, owner, volatility, search_path/config and execute grants.
7. Triggers, views/materialized views, sequences, extensions and default privileges.
8. Application SQL references and route/service/job ownership.
9. Data sensitivity and member/business ownership.
10. Negative tests for every denied operation.

The complete exact column/FK/index/function inventory has **not** been produced by this review. This schema-family summary is not a substitute for that catalog export.

## 5. Initial risk and defect register

| Priority | Finding | Evidence / consequence | Closure evidence |
|---|---|---|---|
| P0 | Live Supabase public schema has RLS disabled and broad grants | Previously inspected 37-table live schema | Table-specific role matrix, non-bypass runtime role, full-schema disposable tests, reviewed rollout |
| P0 | Runtime DB role is not proven non-bypass | PR #24 itself marks this unknown | Sanitized role identity and `rolsuper`/`rolbypassrls` evidence from actual deployment |
| P0 | Institution identity/authority inconsistent | Conflicting names and fictional disclaimers | Written authority and approved identity/disclosure register |
| P1 | Competing ledger schemas | Legacy ledger, #16 model and #20 journal foundation overlap | Canonical entity map, migration compatibility, concurrency/invariant tests |
| P1 | Competing auth architecture | #19 Supabase Auth vs #24 cookie sessions | Approved identity architecture and migration/rollback plan |
| P1 | Multiple migration runners/schema families | Express and Supabase migrations are separate | Documented migration ownership and tested deployment order |
| P1 | Access layer incomplete | #24 says route SQL remains and worker role needs design | Route-to-repository inventory and actual application-path tests |
| P1 | Application journey is stacked/fragmented | #21 depends on #18; portals remain separate | Full journey tests through member request, operator decision and notification |
| P1 | Worker runtime not deployed | #23 says no worker deployed/started | Staging deployment and scoped identity/lease/recovery evidence |
| P2 | Provider access unverified | Adapters/foundations do not prove account, agreement or production API access | Dashboard, agreement, scopes, webhook and successful test evidence |
| P2 | Local demo risk at public root | Advanced README identifies root as local-storage simulator | Remove or isolate simulator; root must not imply live accounts or balances |

## 6. Recommended integration plan

### Gate A — Freeze evidence
- Record exact PR heads/base SHAs before cherry-pick/rebase.
- Keep PR #24 open and draft.
- Keep production Supabase unchanged.
- Use disposable PostgreSQL and a disposable Supabase branch/project for schema tests.

### Gate B — Reconcile dependencies
1. Use PR #23 → PR #24 as the initial security/runtime spine.
2. Rebase/stack PR #18 onto that spine and resolve access-layer overlap.
3. Reconcile PR #21 on top of the reconciled #18.
4. Compare PR #20 schema against PR #16; select one canonical journal model or document bounded coexistence.
5. Decide whether PR #19 is deferred or becomes a future auth migration.
6. Review PR #17 and correct all institution-name claims before public-page adoption.
7. Update PR #22 after the code baseline is known.

### Gate C — Full target-schema inventory
- Export live 37-table catalog and all selected migration DDL.
- Diff names, columns, constraints, indexes, functions, policies and grants.
- Map every application SQL query to table and actor.
- Add tables only when purpose, owner, data class and access model are explicit.

### Gate D — Disposable integration validation
- Apply migrations from a clean database in documented order.
- Test replay, partial failure, rollback and migration drift.
- Run API suite plus ledger concurrency, reversal, replay, insufficient-funds, cross-member and business-role tests.
- Run worker lease, duplicate delivery, service revocation and team isolation tests.
- Run actual HTTP routes using the intended non-bypass role.
- Test pooled actor-context reset and missing/forged actor context.
- Verify browser roles cannot directly access protected tables/functions.

### Gate E — Security design
- Produce table-specific policies and SQL grants separately.
- Test function execution privileges and SECURITY DEFINER functions independently.
- Confirm app, migration, worker and break-glass roles are distinct and least privilege.
- Only then propose a production migration. Production changes require explicit authorisation and an approved change window.

## 7. Explicit non-claims

This reconciliation does not establish that any PR is merged; any provider account/API is active; any new migration has been applied to production; the runtime role is non-bypass; all 37 tables are protected by RLS; any worker is deployed; cards are issued; loans are underwritten/funded; money is moved; the software is authorised to represent Atchison Village Credit Union; or the replacement site is ready to cut over.

**Status:** documentation committed on the PR #24 development branch. No feature branch was merged and no production system was changed.
