# PR #16 / PR #20 operation-level access matrix

**Status:** design and reconciliation artifact only. Not a policy migration. No SQL in this document is applied to production or either pull request.

## Evidence and scope

- PR #16 head: `74e6f87a3235d9f3614e3a760e0370196aec30ad`
- PR #20 head: `6a097a9d2e265d8f5497eda94020abedacaf6d0e`
- PR #16 migration: `server/migrations/012_asset_aware_double_entry_ledger.sql`
- PR #20 migrations: `supabase/migrations/202610310001_member_identity_foundation.sql` through `202610310005_provider_event_worker.sql`
- These are separate schema proposals. PR #16 references `public.members`; PR #20 binds identity to `auth.users` through `public.member_profiles`. They are not interchangeable.
- PR #16 declares 10 tables, 4 trigger functions, 5 triggers (2 deferred constraint triggers), and 14 indexes.
- PR #20 declares 11 tables, 12 functions, 2 ledger guard triggers, 3 enums, and its own RLS/grant model.
- The PR #20 draft-journal function has a malformed dollar-quote terminator in the checked source. Any fixture repair is test-only and does not repair the PR.
- PR #16 creates no RLS policies or grants for its new tables. Its access state is therefore **undefined by this migration** and must not be described as a secure grant model.
- PR #20 enables RLS on all 11 tables. It defines one authenticated own-profile SELECT policy. Other client roles have no policies; several tables explicitly revoke client privileges. Its ledger functions are explicitly restricted to `service_role`. The migrations do not define narrowly separated service identities.
- Table-level permissions below are **proposed target permissions**, not a statement of current effective PostgreSQL grants. Explicit grants/revokes are separately called out where material.

## Permission vocabulary

- **Member**: authenticated end-user identity. PR #16 assumes an application member row; PR #20 uses `auth.uid() -> member_profiles.auth_user_id`.
- **Support**: case-handling operator, assigned case scope only; no ledger authority.
- **Management**: operational approver within configured product and monetary limits; no self-approval.
- **Auditor**: independent read-only reviewer with masked/minimized evidence; no business mutations.
- **Admin**: separately authorized operator-administration function, step-up authentication and dual control for sensitive changes. Not synonymous with database owner.
- **System identities**: distinct non-human principals, each purpose-bound: `identity-provisioner`, `ledger-draft-writer`, `ledger-poster`, `ledger-reversal-approver`, `provider-ingress`, `provider-verification-adapter`, `provider-event-worker`, `outbox-dispatcher`. These are logical target identities; they do not exist merely because a Supabase `service_role` exists.
- **DB owner/migration principal**: deployment-only DDL owner. Not used by web requests, workers, operators, or auditors.

Permission shorthand: **R** SELECT; **C** INSERT; **U** UPDATE; **D** DELETE; **X** EXECUTE on the associated routines; **O** ownership/DDL. “No” means deny. “Scoped” always means enforced in a trusted server query and, where client access exists, by RLS—not merely hidden in UI code.

## PR #16: asset-aware ledger/business schema

For all PR #16 tables, the migration currently supplies no RLS, policies, table grants, or role definitions. Every permission in this table is a **proposed least-privilege target** pending identity and schema reconciliation.

| Table | Member R/C/U/D | Support R/C/U/D | Management R/C/U/D | Auditor R/C/U/D | Admin R/C/U/D | Dedicated system R/C/U/D | Row scope, write path, approval, audit |
|---|---|---|---|---|---|---|---|
| `business_profiles` | No | No | Scoped R; no C/U/D | Masked R | Scoped R; no direct mutation | KYB/onboarding service C/U; no D | Business only where membership is active. Server KYB workflow; activation/restriction requires independent review. Record every status transition and evidence reference. |
| `business_memberships` | Scoped R; request changes only | No | Scoped R; approve/revoke through service | Masked R | Exceptional R; no direct D | Membership service C/U; no D | Member sees own business memberships. Owner/admin role change requires business authority validation and step-up; append audit event for grant/revoke. |
| `financial_accounts` | Own-account R; no C/U/D | No | Scoped R; no direct C/U/D | Masked R | Exceptional R; no direct C/U/D | Account-provisioner C; lifecycle service U; no D | Member/business/system owner scope. Provisioning only after verified onboarding/provider approval; status and provider refs audited. |
| `journal_transactions` | No | No | Scoped R; approve request only | Read-only R, sensitive fields minimized | R; no direct C/U/D | Draft writer C; poster may transition draft to posted; reversal service only controlled reversal | No member direct writes. Draft -> post is atomic server function; reversal is compensating transaction with independent authorization. Immutable audit for create/post/reverse. |
| `journal_entries` | No | No | No direct line access; summarized R only | Read-only R, masked | Read-only R | Draft writer C only while parent is draft; no U/D; posting service validates | Parent-transaction scope. Never edit/delete posted lines; corrections via compensating journal. Every posting linked to actor, request, and audit event. |
| `balance_holds` | Own-account summary R; no direct C/U/D | No | Scoped R; authorize release only via service | Masked R | R; no direct C/U/D | Risk/authorization service C/U; no D | Account owner scope. Place/release/capture/expire only via server state machine; release/capture may require approval by risk/management. Reason and actor audited. |
| `external_payment_intents` | Own intents R; create request through API, no direct C/U/D | No | Scoped R; approve/reject through approval service | Masked R | R; no direct D or status override | Payment-orchestrator C/U; provider adapter updates through verified workflow | Own account/business permission scope. Approval threshold, sanctions/risk checks and dual control before submission. Full lifecycle audit; never client-settle. |
| `provider_events` | No | No | Operational status summary only | Masked R | R metadata only | Provider-ingress C; verification adapter records verified status; event worker claims/updates processing | Provider/event scope. Raw payload and signature evidence restricted. Verification must be performed cryptographically by adapter; a caller-supplied reference alone is not proof. Append conflict and processing audit. |
| `financial_outbox` | No | No | No | Metadata-only R | Metadata-only R | Outbox dispatcher claims/updates/sends; domain service inserts event | Service/event scope. No browser access. Payload minimized and encrypted where appropriate; retry/dead-letter and delivery evidence immutable/audited. |
| `business_account_permissions` | Own grants R; request changes only | No | Scoped R; approve grants/revocations | Masked R | Exceptional R; no direct C/U/D | Business-permission service C/U; no D | Business/member/permission scope. Enforce payment limits and separation of create vs approve; no self-approval. Grant, change, revoke audited. |

### PR #16 routine EXECUTE and ownership

| Routine / trigger | EXECUTE target | Purpose and boundary | Approval / audit |
|---|---|---|---|
| `avcu_assert_journal_balanced()` | Trigger-only; no application EXECUTE | Deferred constraint trigger validates posted journal balance per asset | Must remain attached to both relevant constraint triggers; failed post rolls back. |
| `avcu_reject_journal_entry_mutation()` | Trigger-only; no application EXECUTE | Blocks update/delete and inserts against finalized journal | Immutable-line enforcement; compensating journal only. |
| `avcu_guard_finalized_journal()` | Trigger-only; no application EXECUTE | Blocks mutation of posted/reversed transaction except narrowly permitted reversal status transition | Reversal must be a separate controlled process and audit event. |
| `avcu_validate_external_payment_asset()` | Trigger-only; no application EXECUTE | Validates open account and compatible asset/custody rail | Payment orchestrator must still enforce authorization and approval. |
| All ten tables / all four routines | Migration owner only: O | Ownership, DDL, trigger replacement, grant/policy changes | Deployment identity only, MFA/short-lived credential, reviewed migration, change ticket and deployment log. Never app or worker ownership. |

## PR #20: Supabase identity, banking, jurisdiction and provider-event schema

This matrix separates human roles from purpose-specific server identities. The current migration explicitly grants `authenticated` SELECT on own `member_profiles`; explicitly revokes `anon`/`authenticated` table access on the financial and provider tables; and grants `service_role` SELECT on ledger transactions, ledger entries and provider events while revoking its direct insert/update/delete on ledger lines and transactions and requiring SECURITY DEFINER functions for mutations. Do not infer that all other service-role table grants are least-privilege or absent without inspecting the target project's effective grants/default privileges.

| Table | Member R/C/U/D | Support R/C/U/D | Management R/C/U/D | Auditor R/C/U/D | Admin R/C/U/D | Dedicated system R/C/U/D | Row scope, write path, approval, audit |
|---|---|---|---|---|---|---|---|
| `member_profiles` | Own non-sensitive profile R only; no C/U/D | No | Minimal status R through service | Masked R | Exceptional R; no direct mutation | Identity-provisioner C/U; no D | Own row via `auth.uid()`. Current migration has own-profile SELECT policy and authenticated SELECT grant. Provision/status changes are trusted, audited operations; account closure/recovery requires controlled workflow. |
| `avcu_financial_accounts` | Own account summary R through server projection; no direct C/U/D | No | Scoped R; approve lifecycle only | Masked R | R metadata; no direct C/U/D | Account-provisioner C; lifecycle service U; no D | `owner_profile_id` scope. RLS enabled; no client policy. Provider account opening only after jurisdiction/product/provider authorization and independent approval. |
| `avcu_ledger_accounts` | No | No | Summary R only | Read-only R, restricted chart-of-accounts fields | R; no direct mutation | Chart-of-accounts provisioner C/U during controlled setup; no D | System/account classification. Not a member-facing balance source. Changes require accounting approval, migration review and audit. |
| `avcu_ledger_transactions` | Own transaction projection R; no direct C/U/D | No | Scoped R; approve business request, not direct post | Read-only R, masked | R; no direct mutation | Draft writer through `avcu_create_draft_ledger_transaction`; poster through `avcu_post_ledger_transaction`; reversal approver through `avcu_reverse_ledger_transaction` | Account/member scope. Current migration revokes service_role direct C/U/D and grants SELECT; mutation via SECURITY DEFINER functions. Posting/reversal require policy checks, separate authority, immutable audit. |
| `avcu_ledger_entries` | No direct access | No | No direct line access | Read-only R, minimized | R only for controlled investigation | Ledger-draft-writer inserts only via draft function; no direct U/D; poster finalizes parent | No member/client writes. Per-currency balancing and account-currency validation before post. Posted lines immutable; corrections by compensating journal. |
| `avcu_provider_events` | No | No | Status summary only | Masked metadata R | Metadata R | Provider-ingress creates event; verification adapter marks verified; event-worker claims/completes/retries/quarantines via distinct routines | Provider/event scope. Current migration revokes service_role direct C/U/D and grants SELECT; functions are SECURITY DEFINER. Signature validation must be independently evidenced; quarantine/replay conflicts audited. |
| `avcu_jurisdictions` | No | No | Scoped R | R | R; no direct C/U/D | Jurisdiction-config service C/U through reviewed change | Jurisdiction reference scope. Country classification is not regulatory authorization. Changes require legal/compliance review and versioned audit. |
| `avcu_product_authorizations` | No | No | Scoped R | R | R; no direct C/U/D | Product-control service C/U | Product + jurisdiction + entity + provider scope. Fail closed unless current approval evidence exists. Changes require compliance sign-off and audit. |
| `avcu_provider_routes` | No | No | Operational summary R | R metadata | R; no direct secret access | Provider-routing service C/U; no D | Product/jurisdiction/provider route scope. Credentials stored separately in secret manager. Route activation requires provider and compliance approval; every change audited. |
| `avcu_ledger_audit_events` | No | No | Scoped R | Read-only R | Read-only R; no mutation | Ledger functions append events only; no direct update/delete | Transaction scope, actor and reason required. RLS enabled and current migration revokes all from client/service_role; ensure function owner can insert. Immutable evidence, retention and independent review. |
| `avcu_provider_event_conflicts` | No | No | Operational summary only | Read-only masked R | R metadata | Provider-ingress function inserts conflict evidence; no direct mutation | Provider/event id + hashes only. Current migration enables RLS and revokes all from public/anon/authenticated/service_role. Ensure definer owner can persist evidence; do not raise in a way that rolls back the conflict insert. |

### PR #20 routine EXECUTE and ownership

| Routine | Dedicated EXECUTE identity | Human/client EXECUTE | Scope / required guard |
|---|---|---|---|
| `avcu_capability_is_enabled(text,text,text,text,text,text)` | Jurisdiction/product decision service only | No | Read-only capability evaluation; never itself constitutes regulatory approval. Current migration grants service_role; replace with narrower identity at deployment. |
| `avcu_guard_ledger_entry_write()` | Trigger-only | No | Prevents unauthorized ledger-entry writes; trigger owner and trusted operation context must be reviewed. |
| `avcu_guard_ledger_transaction_update()` | Trigger-only | No | Protects transaction state transitions; no direct client call. |
| `avcu_create_draft_ledger_transaction(...)` | `ledger-draft-writer` | No | Validate payload, idempotency, account/currency ownership and caller authority. Current function source has malformed dollar-quote terminator; do not deploy until corrected and reviewed. |
| `avcu_post_ledger_transaction(uuid)` | `ledger-poster` | No | Locks draft, validates minimum lines and per-currency balance, posts atomically, appends audit event. Require independent approval/risk decision before execution. |
| `avcu_reverse_ledger_transaction(uuid,text)` | `ledger-reversal-approver` | No | Compensating journal only; reason required. Require maker-checker, no self-approval, idempotency and audit. |
| `avcu_ingest_provider_event(text,text,text,jsonb)` | `provider-ingress` | No | Validate input and idempotency; store unverified event. No posting authority. |
| `avcu_mark_provider_event_verified(uuid,text)` | `provider-verification-adapter` | No | Must be callable only after adapter verifies raw-body signature, timestamp tolerance, key rotation and replay. Reference string alone is insufficient proof; bind verification to authenticated adapter evidence. |
| `avcu_claim_provider_event(text,integer)` | `provider-event-worker` | No | Lease/claim only; worker identity must be authenticated, not caller-selected arbitrary text. |
| `avcu_complete_provider_event(uuid,uuid)` | `provider-event-worker` | No | Valid unexpired lease token and verified event required. |
| `avcu_retry_provider_event(uuid,uuid,text,integer)` | `provider-event-worker` | No | Valid lease, bounded retry interval and attempt limit; audit failure code. |
| `avcu_quarantine_provider_event(uuid,uuid,text)` | `provider-event-worker` or separate risk-quarantine identity | No | Valid lease and reason; independent review before release/replay. |

All SECURITY DEFINER functions require a non-login owner, fixed safe `search_path`, schema CREATE privilege revoked from untrusted roles, explicit EXECUTE revocation from PUBLIC/anon/authenticated, minimal argument validation, row-level authorization inside the function, concurrency/locking review, and an audit event in the same transaction where appropriate. A shared `service_role` credential is not a substitute for distinct database roles or independently authenticated service identities.

## Cross-cutting authorization and ownership rules

1. **No direct member writes** to ledger lines, posted transactions, provider inbox, audit events, jurisdiction/product/provider controls, or service queues.
2. **Requests are not postings.** Transfers, deposits, payments, card/loan actions and money requests are requests until server-side checks, approvals and provider outcomes authorize state transitions.
3. **Maker-checker:** creator cannot approve/post/reverse their own sensitive request. High-risk actions require two distinct authorized humans or an independently governed automated policy plus human escalation.
4. **Row scope:** member = own profile/account/application; business user = active business membership plus explicit permission and amount limit; support = assigned case; management = assigned jurisdiction/product and approval limit; auditor = read-only minimum evidence; system identity = service/task/event scope.
5. **Audit:** actor identity, actor type, service identity, correlation/idempotency key, subject row, action, before/after hash or minimized diff, reason, approval chain, timestamp, request source, and outcome. Audit storage is append-only, independently readable, and inaccessible for update/delete to application roles.
6. **Ownership:** only a deployment/migration principal owns schemas/tables/functions and performs DDL. Runtime functions should be owned by a locked-down non-login role. No web app, operator, auditor or worker is table owner.
7. **No wildcard privilege:** no `GRANT ALL`, no browser `service_role`, no shared worker credential, no role membership that silently inherits broad privileges. Sequence and function EXECUTE grants must be inventoried separately.
8. **Fail closed:** missing identity mapping, inactive membership, unknown jurisdiction, absent product authorization, unverified provider event, expired lease, unknown status or unavailable approval evidence means deny/hold—not proceed.

## Architecture reconciliation gates before any policy migration

| Conflict | Evidence in the PR definitions | Decision required before implementation |
|---|---|---|
| Member identity | PR #16 FK references `members(id)`; PR #20 introduces `member_profiles.auth_user_id -> auth.users(id)` | Select one canonical identity key and migration/backfill mapping. Define session ownership, recovery, lockout, deletion and audit. No dual identity lookup fallback. |
| Ledger model | PR #16 uses `financial_accounts`, `journal_transactions`, `journal_entries` with asset_code/amount_minor and business ownership; PR #20 uses `avcu_financial_accounts`, `avcu_ledger_accounts`, `avcu_ledger_transactions`, `avcu_ledger_entries` with currency and debit/credit amounts | Select one canonical ledger or design a formally mapped bounded context. Define account ownership, asset/currency semantics, holds, reversals, idempotency, chart of accounts and historical migration. Do not run both as parallel sources of truth. |
| Migration authority | PR #16 uses Express `server/migrations/*.sql`; PR #20 uses Supabase `supabase/migrations/*.sql` | Choose one ordered migration authority, lock mechanism, environment promotion, rollback/forward-fix policy and schema-drift check. |
| Privileged function authority | PR #20 exposes multiple SECURITY DEFINER routines through `service_role`; PR #16 has trigger functions but no grants/policies | Define function owner, dedicated EXECUTE identities, authentication of worker/provider adapters, actor provenance, step-up/dual approval, and least-privilege grants. |
| RLS / effective grants | PR #16 new tables lack RLS/grants; PR #20 enables RLS but relies on policies/grants plus SECURITY DEFINER owner rights | Capture effective grants, default privileges, owners, sequence rights, schema CREATE, function EXECUTE and RLS policies in the exact target project. Do not infer from migration text alone. |
| Provider verification | PR #20 marks verified through a SECURITY DEFINER routine taking a text reference | Bind verification to cryptographic adapter evidence and authenticated adapter identity; reject arbitrary worker-supplied references. |
| Conflict evidence | PR #20 conflict insert is followed by an exception in the same function | Ensure conflict evidence survives error handling (separate transaction/outbox or catch-and-return design); test rollback semantics. |

## Required test evidence before policy approval

- Disposable PostgreSQL built from exact PR heads, with the PR #20 syntax defect fixed only in a clearly labelled test copy.
- Catalog snapshot: table/column definitions, PK/FK/unique/check constraints, indexes, triggers, function owners/config, SECURITY DEFINER, EXECUTE grants, table/sequence grants, default privileges, schema CREATE and RLS/force-RLS state.
- Separate non-superuser, NOBYPASSRLS roles for member A, member B, support, management, auditor, admin, each service identity, and migration owner.
- Positive and negative tests for every table and each CRUD operation; function EXECUTE allow/deny tests; row-scope tests; pooled-connection actor-context reset; ownership/DDL denial; sequence access; direct-write bypass attempts.
- End-to-end route tests proving the API never leaks a broader database credential or permits a client to choose its own actor/service identity.
- Approval tests: self-approval denied, independent approver accepted, limits enforced, expired/revoked membership denied, idempotent retry safe.
- Audit tests: required events committed atomically; failed operation does not leave false success; conflict evidence persists despite rejected replay; no update/delete/truncate path for audit records.
- CI results tied to the exact PR head and disposable fixture commit. No test result is represented as production verification.

## Current disposition

**Not ready for combined policy migration, merge, deployment, or live financial operations.** This matrix is a proposed target model grounded in the PR migration definitions. It does not assert that effective permissions in any deployed database match it. The next implementation step is architecture reconciliation plus catalog-level grant/ownership capture, followed by disposable route-level authorization tests.