# AVCU architecture reconciliation decision record

**Status:** proposed architecture baseline; implementation blocked pending review and exact-source reconciliation.  
**Date:** 2026-10-31  
**Scope:** reconcile PR #16, PR #20 and the existing AVCU Supabase project before any combined permission/RLS migration.  
**Change safety:** documentation only. No production SQL, grants, policies, roles, credentials, data, provider connections or financial operations were changed.

## 1. Executive decision

Adopt the PR #20 Supabase/Auth-oriented model as the target architecture, subject to the gates in this record:

1. **Canonical member identity:** Supabase Auth `auth.users.id` is the canonical authentication principal. `member_profiles.auth_user_id` is the one-to-one AVCU member-domain mapping. Legacy `members.id` remains a migration/source identifier, not a second login identity.
2. **Canonical ledger:** PR #20's `avcu_ledger_accounts`, `avcu_ledger_transactions`, `avcu_ledger_entries` are the target accounting ledger. PR #16's asset-aware `financial_accounts`, `journal_transactions`, `journal_entries` are a legacy/import source and domain reference, not a second balance authority. Preserve holds, business ownership/permissions and payment-intent concepts as explicit supporting domains only after their semantics are mapped.
3. **Migration authority:** Supabase `supabase/migrations` is the sole future schema-change authority. The Express `server/migrations` runner is frozen for schema changes after its outstanding changes are reconciled and migrated. Application startup must not independently apply schema migrations.
4. **Privileged execution:** no application or worker receives a shared broad database credential as its authorization boundary. Use non-login capability roles and separately authenticated service principals, with narrow table grants and EXECUTE grants. Supabase's built-in `service_role` remains an infrastructure bypass principal and must not be treated as a purpose-specific application identity.
5. **Effective access baseline:** the current live project does not match the intended target. Do not deploy policies piecemeal; first create a complete catalog snapshot and a staged, tested remediation plan.

These are architecture decisions for the AVCU codebase. They do not establish institutional authority, regulatory approval, provider readiness or permission to operate financial services.

## 2. Evidence and confidence

### 2.1 Competing PR schema evidence

The reviewed schema proposals are distinct:

- PR #16: `server/migrations/012_asset_aware_double_entry_ledger.sql`; references legacy `members(id)`; defines asset-aware financial accounts and journal transactions/entries, business membership/permissions, holds, payment intents, provider events and outbox.
- PR #20: five ordered `supabase/migrations/202610310001_...` through `202610310005_...`; introduces `member_profiles.auth_user_id -> auth.users(id)`, separate AVCU financial/ledger tables, jurisdiction/product/provider controls, ledger audit and provider-event conflict evidence.
- PR #16 does not define RLS policies or grants for its added tables.
- PR #20 enables RLS for its own 11 tables, but its privileged routines are broadly exposed through the built-in `service_role`; it is not a complete purpose-specific identity design.
- The PR #20 draft-ledger routine has a malformed dollar-quote terminator in the reviewed source. It must be corrected in the PR and tested from the exact source before merge; test-fixture repairs do not count.

The PR16/PR20 operation-level matrix remains the source for the detailed proposed per-table permissions pending this architecture decision.

### 2.2 Existing live Supabase catalog snapshot

Read-only catalog inspection of project ref `ochbrwwgwikwiaoqupkt` on 2026-10-31 returned:

| Finding | Observed |
|---|---:|
| Public base/partitioned tables | 37 |
| Public tables with RLS enabled | 0 |
| Public tables with FORCE RLS | 0 |
| Public RLS policies | 0 |
| Public table owners | 37 owned by `postgres` |
| Public user-defined functions | 1 |
| Public sequences | 14 |
| `anon` table-level grants | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on all 37 |
| `authenticated` table-level grants | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on all 37 |
| `service_role` table-level grants | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on all 37 |
| Public schema ACL | USAGE granted to PUBLIC, postgres, anon, authenticated and service_role |
| Default table ACLs in public | defaults grant broad table privileges to anon, authenticated and service_role for objects created by postgres and supabase_admin |
| Default function ACLs in public | EXECUTE defaults include anon, authenticated and service_role for functions created by postgres and supabase_admin |

Role attributes observed: `anon` and `authenticated` are non-superuser and NOBYPASSRLS; `service_role` is non-superuser but BYPASSRLS; `postgres` is BYPASSRLS. These attributes do not neutralize the broad explicit table grants. The catalog result establishes a serious authorization-boundary defect; it does not by itself prove that an unauthenticated external party successfully accessed any specific row.

**Critical implication:** merely enabling RLS later is not sufficient. Existing explicit grants and permissive default privileges must be addressed in the same controlled access design, including sequences, functions, schema privileges, owner bypass and service credentials.

### 2.3 Snapshot limitations

The above is a read-only baseline, not the complete final catalog audit. Before policy design, capture and retain:
- every relation's owner, RLS/FORCE RLS, columns, generated/default expressions, constraints, indexes and triggers;
- complete table, column, sequence, schema and function ACLs, including PUBLIC grants and grant options;
- all default ACL entries grouped by creator role and schema;
- function owner, language, SECURITY DEFINER, volatility, configuration/search_path and effective EXECUTE grants;
- role memberships, inheritance, SET ROLE paths, role attributes and ownership dependencies;
- views/materialized views, partitions, security-invoker/definer behavior and exposed API schemas;
- storage/API exposure and application connection paths;
- exact migration history and schema drift.

## 3. Canonical identity contract

### Target
- Authentication principal: `auth.users.id` UUID.
- AVCU member record: `member_profiles.id` is the internal domain key; `member_profiles.auth_user_id` is UNIQUE, NOT NULL for active login-capable members, and references `auth.users(id)`.
- Every member-owned domain table references `member_profiles.id` (or a stable internal member key) consistently. Do not mix raw auth IDs and legacy member IDs in foreign keys.
- Operator identities remain a separate workforce identity domain with independent MFA, lifecycle, team membership, permissions and audit. A member account must not automatically become an operator.
- A service principal is not a member and cannot impersonate one by choosing an actor UUID.

### Legacy mapping and migration
1. Build a deterministic mapping table from legacy `members.id` to `auth.users.id` and `member_profiles.id`, with uniqueness in both directions and immutable source identifiers.
2. Verify each mapping using the approved account-linking process; do not match solely on mutable email addresses.
3. Preserve member number, KYC/onboarding state, lockout/recovery state, consent, timestamps and historical audit references.
4. Reconcile legacy `member_sessions` and password-reset tokens. Do not migrate raw session secrets; revoke legacy sessions and require secure reauthentication/reset where necessary.
5. Quarantine duplicate, orphaned, conflicting or unverified mappings. No fallback lookup across both identity systems.
6. Cut over only after counts, referential integrity, sampled identity verification, recovery tests and rollback/forward-recovery procedures pass.

### Required identity tests
Member A cannot read/update Member B; deleted/disabled/unlinked auth identity is denied; email change does not reassign membership; duplicate mappings fail closed; stale legacy session is rejected; recovery cannot bind an attacker-controlled auth user; operator and member principals cannot cross boundaries.

## 4. Canonical ledger contract and PR #16 mapping

### Canonical accounting core
PR #20's debit/credit journal model is canonical for accounting:
- `avcu_ledger_accounts`: chart-of-accounts and accounting classification.
- `avcu_ledger_transactions`: journal transaction lifecycle and posting state.
- `avcu_ledger_entries`: immutable debit/credit lines.
- `avcu_ledger_audit_events`: append-only event evidence.
- `avcu_financial_accounts`: member/business-facing account domain and mapping to ledger accounts.

A posted ledger transaction is the authoritative accounting event. Display balances are derived from posted ledger entries or a controlled, reconciled projection; they are not independently writable balances. Drafts, holds, payment intents and provider events are not postings.

### PR #16 object mapping

| PR #16 source | Target treatment | Required mapping / guard |
|---|---|---|
| `financial_accounts` | `avcu_financial_accounts` plus one or more `avcu_ledger_accounts` | Map owner type/id, product, asset/currency, account state, provider references and chart-of-accounts classification. No automatic 1:1 assumption until semantics are verified. |
| `journal_transactions` | `avcu_ledger_transactions` | Map source transaction ID, lifecycle/status, effective/created timestamps, idempotency key, actor, reference and reversal relationship. Preserve source ID uniquely for traceability. |
| `journal_entries` | `avcu_ledger_entries` | Map debit/credit polarity and amount_minor exactly; validate per-currency balance, precision, sign, account currency and immutable posting. Never infer polarity from ambiguous legacy labels. |
| `balance_holds` | Separate hold/reservation domain referencing financial account and ledger transaction | A hold is an availability/reservation state, not a journal posting. Define place/release/capture/expire and accounting treatment explicitly. |
| `external_payment_intents` | Payment-intent/workflow domain linked to account and eventual ledger transaction | Intent/request and provider outcome are not settled money. Only verified, authorized settlement produces a ledger posting. |
| `provider_events` | `avcu_provider_events` | Preserve provider event ID, raw-body hash, signature/key metadata, received time, verification result and replay/idempotency evidence. Keep raw payload restricted. |
| `financial_outbox` | Existing durable outbox/job infrastructure or a dedicated transactional outbox | Ensure event insertion is atomic with domain transition; idempotent delivery; bounded retries; dead-letter and replay audit. |
| `business_profiles` | Separate business/KYB domain, not an identity or ledger substitute | Preserve business ownership and verification evidence; require legal authority before enabling business products. |
| `business_memberships` | Business membership/role domain | Map member to business through canonical member profile; active status and scope checked on every operation. |
| `business_account_permissions` | Business entitlement/limit domain | Preserve action scopes, limits and dual-control rules; never grant ledger posting merely from business membership. |

### Ledger migration invariants
- Preserve exact minor-unit values and currency/asset identity; never perform lossy float conversion.
- Define currency versus non-fiat asset semantics explicitly. A currency code cannot silently replace an arbitrary asset code.
- Every posted transaction balances independently per currency/asset and uses valid account classifications.
- Preserve transaction IDs and entry IDs as source references; do not reuse them as target primary keys without collision analysis.
- Reconcile opening balances, pending items, holds, reversals, fees, chargebacks and provider settlement states.
- Historical entries are imported as historical facts with provenance; do not replay them as new live money movement.
- Run source-to-target row counts, amount totals by asset/currency/account/status/date, hash totals, orphan checks and independent accounting sign-off.
- Freeze writes or use a controlled dual-write/cutover protocol with reconciliation; never run two writable ledgers in parallel.

## 5. Migration authority contract

Supabase migrations become the sole schema authority:
- One ordered, immutable migration stream under `supabase/migrations/`.
- All schema changes reviewed in Git, applied first to disposable/test environments, then approved staging, then production only after explicit authorization.
- CI verifies migration ordering, clean replay, drift, rollback/forward-fix plan and catalog postconditions.
- App boot and worker startup must never run DDL or apply migrations.
- Freeze `server/migrations/`; inventory and port each still-needed migration once, preserving its source checksum and historical ordering in a migration ledger.
- Existing applied migrations are not edited. Correct defects with a new forward migration.
- Use a single deployment principal controlled by CI/operations; no runtime role owns tables or performs DDL.
- Production migration execution requires explicit approval, backup/restore proof, maintenance/rollback plan and post-deploy verification.

## 6. Purpose-specific identity model

Separate authorization capabilities from authentication credentials. Suggested NOLOGIN capability roles:

| Capability role | Allowed purpose | Explicit exclusions |
|---|---|---|
| `avcu_member_read` | Read member-safe own-scope projections | No direct ledger writes, provider access, operator data or DDL |
| `avcu_support_case` | Assigned support-case read and controlled case-message workflow | No member credentials, account mutation, ledger, approval or payment authority |
| `avcu_auditor_read` | Read-only minimized audit and reconciliation evidence | No writes, secret access or DDL |
| `avcu_identity_provisioner` | Create/update member-profile linkage through guarded routine | No authentication credential management beyond approved Auth integration; no ledger/provider actions |
| `avcu_ledger_draft` | Create validated draft journal via a narrow routine | Cannot post, reverse, edit posted lines or approve own work |
| `avcu_ledger_poster` | Post eligible approved drafts atomically | Cannot draft or reverse; requires independent approval evidence |
| `avcu_ledger_reverser` | Create compensating reversal under separate approval | Cannot alter/delete original posted transaction |
| `avcu_provider_ingress` | Insert unverified provider event | Cannot verify, claim, post or settle |
| `avcu_provider_verifier` | Record adapter-authenticated cryptographic verification | Cannot create arbitrary event or post ledger |
| `avcu_provider_worker` | Claim/complete/retry/quarantine leased events | Cannot self-assert verification or directly post money |
| `avcu_outbox_dispatcher` | Claim and deliver approved outbox messages | Cannot change financial state or create ledger postings |
| `avcu_migration_owner` | Own schema objects and perform approved DDL | Never used by app, API, operator, auditor or worker |

Runtime identities authenticate separately (for example, workload identity/short-lived credentials or separately rotated secrets in a managed secret store) and receive membership only in the capability role(s) required. No shared token may select an arbitrary database role or actor. If Supabase's gateway cannot provide distinct DB login roles per workload, isolate privileged functions behind separately authenticated server-side adapters and expose only narrow function EXECUTE grants; document this as a compensating control, not equivalent database identity isolation.

All SECURITY DEFINER functions must have:
- a locked-down non-login owner with only required object privileges;
- fixed trusted `search_path` (schema-qualified object references preferred);
- no untrusted CREATE in any searched schema;
- PUBLIC/anon/authenticated EXECUTE revoked unless intentionally justified;
- exact EXECUTE grants only to the relevant capability role;
- caller/service identity provenance validated inside the function;
- strict argument validation, row locking, idempotency and state-machine checks;
- no arbitrary actor, role, tenant, owner or verification status supplied by caller;
- atomic audit evidence and safe error/conflict handling.

## 7. Live catalog remediation gates

The observed production ACL state is not acceptable as a target. Before changing it:
1. Capture the complete catalog snapshot listed in §2.3 and store a redacted, timestamped artifact in Git.
2. Explain the origin and intended compatibility of every explicit grant, default ACL, schema ACL, function EXECUTE and sequence privilege.
3. Define target ACL for every table, column, sequence, schema, function, view and role.
4. Decide whether the legacy app currently depends on broad service credentials; trace every connection string and code path without exposing secrets.
5. Create disposable PostgreSQL roles that mirror actual request contexts, including member A/B, support, management, auditor, admin, each service identity, migration owner, anon and authenticated.
6. Build and test a complete replacement access model in a disposable database from exact migration heads.
7. Prepare a single coordinated remediation migration with lockout prevention, rollback/forward-fix and operational verification. Do not apply until separately approved.
8. Verify after migration that grants, default ACLs, schema CREATE/USAGE, RLS/FORCE RLS, policies, function EXECUTE, sequences, role memberships and effective privileges match the target exactly.

**Important:** catalog inspection performed for this record was read-only. No live grant, RLS, policy, role, owner, schema or default privilege was changed.

## 8. Test programme: operation matrix and real journeys

### Role and operation tests
For every table and every relevant role, test SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER as applicable; separately test sequence USAGE/SELECT/UPDATE, schema USAGE/CREATE, function EXECUTE, ownership/ALTER/DROP and role membership/SET ROLE. Assert both allowed and denied outcomes. Test column-level grants and PUBLIC privileges. RLS tests must cover USING and WITH CHECK, including rows hidden from UPDATE/DELETE and RETURNING behavior.

### Required real application journeys
1. Registration, identity linking, login, logout, session rotation and recovery.
2. Member reads own profile/accounts/transactions; cannot enumerate or access another member.
3. Member requests a transfer/payment; request remains pending until approvals and provider evidence; no direct posting.
4. Maker creates draft; different authorized checker approves; poster posts atomically; self-approval and limit bypass fail.
5. Reversal creates compensating entries; original posted records remain immutable.
6. Provider webhook ingestion, signature failure, replay, duplicate, conflict persistence, verification, worker lease, retry, quarantine and settlement.
7. Hold placement, capture, release and expiry without balance corruption.
8. Support agent reads only assigned case and cannot see full ledger or secrets.
9. Management reviews/approves within jurisdiction/product/limit; cannot grant itself elevated permissions.
10. Auditor reads minimized immutable evidence and cannot mutate it.
11. Outbox delivery, timeout, retry, dead-letter and replay are idempotent and cannot create duplicate financial effects.
12. Worker A cannot claim/complete Worker B's lease; stale lease and forged identity fail.
13. Pooled connection context resets actor/tenant/service identity between requests.
14. Migration owner can execute reviewed DDL in migration pipeline; runtime principals cannot create/alter/drop objects.
15. Disabled, revoked, deleted or unmapped member/operator/service identities fail closed.

Tests must run with non-superuser, NOBYPASSRLS roles against a disposable database built from exact PR sources. A unit test using postgres/superuser or a mocked repository is not sufficient proof of authorization. Route tests must verify the actual application credential path and that clients cannot choose their own actor or service identity.

## 9. Known blockers and next execution order

| Priority | Blocker | Required action | Exit evidence |
|---|---|---|---|
| P0 | Live project has 0/37 tables with RLS, 0 policies and broad table grants/default ACLs | Complete catalog audit and safe remediation design | Reproducible catalog snapshot and reviewed target ACL |
| P0 | PR #16 and #20 identity models conflict | Implement and validate deterministic identity mapping plan | Backfill simulation, duplicate/orphan report, recovery/session tests |
| P0 | Two ledger models could become competing sources of truth | Complete column/constraint-level mapping and accounting invariants | Signed reconciliation design and import simulation |
| P0 | Migration runners conflict | Freeze Express DDL path and port outstanding migrations | Clean ordered Supabase replay and drift check |
| P0 | service_role is BYPASSRLS and used for broad privileged routines | Create purpose-specific capability/adapter design | Role/EXECUTE matrix and non-superuser integration tests |
| P1 | Provider verification can be asserted through weak reference input | Bind verification to cryptographic adapter evidence | Signature/replay/identity negative tests |
| P1 | Conflict insert may roll back with subsequent exception | Redesign conflict persistence semantics | Test proves evidence persists after rejected duplicate/conflict |
| P1 | Malformed PR #20 dollar quoting | Correct source and test exact PR head | SQL parse/apply and regression tests |
| P1 | Route-to-query tracing is incomplete | Trace every route through repositories/services to SQL | Machine-readable route/table/operation map |
| P1 | Application role journeys not fully tested | Implement disposable role matrix and route-level tests | CI artifacts tied to exact commit |

## 10. Release and safety boundary

This record is a proposed architecture baseline and evidence report. It does not authorize:
- production schema or privilege changes;
- PR merges or deployment;
- live customer/member onboarding;
- card issuance, lending, deposits, transfers or money movement;
- provider integrations or regulatory claims.

No permission migration should be authored/applied until the identity and ledger mappings, migration authority, runtime identity design and complete target catalog snapshot are reviewed together. No production access changes until the disposable operation matrix and end-to-end journey suite pass and the required institutional approvals are documented.
