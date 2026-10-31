# AVCU Security Matrix and Route / DDL Inventory

**Status:** implementation-planning artifact; not a production policy deployment  
**Reviewed branch:** `feat/avcu-access-layer-and-auditor`  
**Reviewed PR:** #24, open draft  
**Reviewed PR #24 head:** `48d3e1f2f1374615277537a1789f3ea558da7875`  
**Live Supabase project:** `ochbrwwgwikwiaoqupkt` (read-only catalog inspection)

## 1. Executive security finding

The live `public` schema currently contains 37 ordinary tables, 89 indexes, one user-defined trigger and one public-schema function. All 37 tables have RLS disabled; there are zero policies. The catalog reports table-level grants for both `anon` and `authenticated` across all 37 tables for SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER.

This is a critical exposure. It does not prove that a remote attacker has successfully accessed data, but it means the database authorization boundary is not currently least-privilege. Do not place member or financial data in this project and do not expose its public client interface until the access model is corrected and tested.

No production DDL, grants, roles, credentials, customer data or financial operations were changed by this review.

## 2. Current live table inventory

| Domain | Live tables |
|---|---|
| Member identity and access | `members`, `member_sessions`, `password_reset_tokens`, `membership_tier_history` |
| Banking and legacy ledger | `accounts`, `transactions`, `ledger_entries` |
| Cards, money requests and funding | `cards`, `money_requests`, `funding_pools`, `funding_contributions` |
| Lending and approvals | `loan_applications`, `approvals` |
| Support and communications | `support_cases`, `case_messages`, `notifications`, `notification_outbox`, `email_delivery_log` |
| Operators and oversight | `operators`, `operator_sessions`, `audit_events`, `operations_alerts` |
| Integrations and AI | `ai_tasks`, `integration_health`, `webhook_events`, `idempotency_keys` |
| Migration and reconciliation | `migration_batches`, `migration_staged_transactions` |
| Privy | `member_privy_links`, `member_privy_wallets` |
| Team runtime | `avcu_team_runtime`, `avcu_team_control_events`, `avcu_service_identities`, `avcu_jobs`, `avcu_job_events`, `avcu_job_dead_letters`, `avcu_worker_heartbeats` |

The table grouping above is an operational classification. Exact column-level sensitivity classification and complete column-by-column DDL diff remain a follow-on item.

## 3. PR #16 DDL inventory — asset-aware ledger

Migration: `server/migrations/012_asset_aware_double_entry_ledger.sql`

### New tables

- `business_profiles`
- `business_memberships`
- `financial_accounts`
- `journal_transactions`
- `journal_entries`
- `balance_holds`
- `external_payment_intents`
- `provider_events`
- `financial_outbox`
- `business_account_permissions`

### Relationships and constraints

- `business_memberships.business_id → business_profiles.id`; `member_id → members.id`; unique business/member pair; revocation timestamp/status consistency.
- `financial_accounts.member_id → members.id`; `business_id → business_profiles.id`; owner-type consistency check; composite unique `(id, asset_code)`; partial unique indexes for member, business, system and provider account references.
- `journal_entries.journal_transaction_id → journal_transactions.id`; composite `(financial_account_id, asset_code) → financial_accounts(id, asset_code)`; amount positive; debit/credit direction constrained.
- `balance_holds` and `external_payment_intents` reference financial account and asset as a composite pair. Holds enforce positive amount and active/resolved timestamp consistency.
- `external_payment_intents` has unique idempotency key and constrained payment rail/status; provider reference is conditionally unique.
- `provider_events` deduplicates provider/event ID; processing status and attempt count constrained.
- `financial_outbox` has unique event key and constrained delivery status.
- `business_account_permissions` references business/member and optional granting member; unique business/member/permission; revocation consistency.

### Functions and triggers

- `avcu_assert_journal_balanced()`: deferred constraint-trigger validation of at least two entries and per-asset debit/credit balance.
- `avcu_reject_journal_entry_mutation()`: blocks mutation/deletion of journal entries; also blocks new entries once parent is finalized.
- `avcu_guard_finalized_journal()`: protects finalized journal transactions except the narrowly shaped posted→reversed state transition.
- `avcu_validate_external_payment_asset()`: verifies account open state and payment rail compatibility with asset/custody type.

Triggers:
- Deferred constraint trigger `journal_entries_balance_check` after entry insert.
- Deferred constraint trigger `journal_transaction_balance_check` after transaction insert/status update.
- `journal_entries_immutable` before insert/update/delete.
- `journal_transactions_finalized_guard` before update.
- `external_payment_asset_guard` before insert or relevant update.

### Indexes

- `idx_business_memberships_member`
- `idx_financial_accounts_member_code_asset` (partial unique)
- `idx_financial_accounts_business_code_asset` (partial unique)
- `idx_financial_accounts_system_code_asset` (partial unique)
- `idx_financial_accounts_member_asset`
- `idx_financial_accounts_business_asset`
- `idx_financial_accounts_provider_ref` (partial unique)
- `idx_journal_entries_account`
- `idx_journal_entries_transaction`
- `idx_balance_holds_active` (partial)
- `idx_external_payment_intents_account`
- `idx_external_payment_provider_ref` (partial unique)
- `idx_provider_events_pending` (partial)
- `idx_financial_outbox_due` (partial)

### Security assessment

This migration does not define RLS, policies or grants for its new tables. It must not be applied to a Supabase-exposed schema as-is. The functions are trigger functions, not SECURITY DEFINER functions. The proposed journal is additive and does not replace the existing `accounts`, `transactions`, or `ledger_entries`; dual-ledger operation would create reconciliation and source-of-truth ambiguity. Resolve this before merging or applying.

Additional review required: prove all trigger paths cover relevant UPDATE/DELETE cases, prove no race can append to a draft while finalization is occurring, and verify the application always wraps journal posting in a single transaction. Review business permission semantics and ensure the permission table cannot grant privileges without independent business-membership validation.

## 4. PR #20 DDL inventory — provider-independent banking

Migration family:
- `supabase/migrations/202610310001_member_identity_foundation.sql`
- `supabase/migrations/202610310002_banking_foundation.sql`
- `supabase/migrations/202610310003_jurisdiction_controls.sql`
- `supabase/migrations/202610310004_ledger_posting_controls.sql`
- `supabase/migrations/202610310005_provider_event_worker.sql`

### New tables

Migration 001:
- `member_profiles`

Migration 002:
- `avcu_financial_accounts`
- `avcu_ledger_accounts`
- `avcu_ledger_transactions`
- `avcu_ledger_entries`
- `avcu_provider_events`

Migration 003:
- `avcu_jurisdictions`
- `avcu_product_authorizations`
- `avcu_provider_routes`

Migration 004:
- `avcu_ledger_audit_events`

Migration 005:
- `avcu_provider_event_conflicts`
- Adds provider-event hash, signature verification timestamp/reference, retry, lease and error columns to `avcu_provider_events`.

### Enumerated types

- `avcu_account_kind`: customer, settlement, fee, suspense.
- `avcu_ledger_account_type`: asset, liability, equity, income, expense.
- `avcu_transaction_status`: draft, pending, posted, failed, reversed.

### Relationships and constraints

- `member_profiles.auth_user_id → auth.users.id`, unique; member number unique; status constrained. This is a separate identity map from the existing `members` table.
- `avcu_financial_accounts` carries provider account identity, country/currency and account status constraints; provider account reference unique by provider.
- `avcu_ledger_accounts`, `avcu_ledger_transactions`, and `avcu_ledger_entries` form a second ledger family. Entries constrain one-sided debit/credit values and currency.
- `avcu_provider_events` uniquely identifies provider event IDs and constrains processing state.
- `avcu_jurisdictions`, `avcu_product_authorizations`, `avcu_provider_routes` model jurisdiction, product approval and provider route state/effective dates.
- `avcu_ledger_audit_events` records ledger lifecycle events.
- `avcu_provider_event_conflicts` records same-event-ID/different-payload conflicts.

### Functions and triggers

Migration 003:
- `avcu_capability_is_enabled(text,text,text,text,text,text)` — SECURITY INVOKER unless catalog definition says otherwise; service_role-only EXECUTE grant is declared.

Migration 004:
- `avcu_guard_ledger_entry_write()`
- `avcu_guard_ledger_transaction_update()`
- `avcu_create_draft_ledger_transaction(...)` — SECURITY DEFINER.
- `avcu_post_ledger_transaction(uuid)` — SECURITY DEFINER; validates balanced entries per currency, validates account currency, posts and records audit event.
- `avcu_reverse_ledger_transaction(uuid,text)` — SECURITY DEFINER; creates compensating transaction and audit event.
- Triggers `avcu_ledger_entry_write_guard` and `avcu_ledger_transaction_update_guard`.

Migration 005 (all SECURITY DEFINER with `search_path = public, pg_temp` in the migration source):
- `avcu_ingest_provider_event(text,text,text,jsonb)`
- `avcu_mark_provider_event_verified(uuid,text)`
- `avcu_claim_provider_event(text,integer)`
- `avcu_complete_provider_event(uuid,uuid)`
- `avcu_retry_provider_event(uuid,uuid,text,integer)`
- `avcu_quarantine_provider_event(uuid,uuid,text)`

No triggers are declared in migrations 001–003 or 005. Migration 004 declares two ledger guard triggers.

### Indexes

- `member_profiles_status_idx`
- `avcu_ledger_entries_transaction_idx`
- `avcu_ledger_entries_account_idx`
- `avcu_product_authorizations_lookup_idx`
- `avcu_ledger_audit_events_transaction_idx`
- `avcu_provider_events_claim_idx`

### RLS and grants in PR #20

RLS is enabled on the identity, banking, jurisdiction, ledger-audit and provider-event-conflict tables listed above. The migrations do not create row policies for these tables. They revoke direct client access and, for several service-role functions, revoke all EXECUTE before granting narrowly scoped EXECUTE back to `service_role`.

Important: RLS enabled with no applicable policy is fail-closed for ordinary roles, but `service_role` bypasses RLS. Explicit grants and function EXECUTE must therefore be audited independently. SECURITY DEFINER routines require owner, EXECUTE grant, fixed search_path, schema CREATE privilege, argument validation, row locking and actor provenance review. The current SQL uses JWT role/session role in audit actor attribution; that is not a sufficient human identity audit trail by itself.

## 5. Competing identity and ledger designs — integration blockers

1. Existing app: opaque cookie sessions, `members`, `member_sessions`, `operators`, `operator_sessions`.
2. PR #19/#20: Supabase Auth `auth.users` and `member_profiles`.
3. PR #16: `financial_accounts`, `journal_transactions`, `journal_entries`.
4. PR #20: `avcu_financial_accounts`, `avcu_ledger_accounts`, `avcu_ledger_transactions`, `avcu_ledger_entries`.
5. Existing live DB: `accounts`, `transactions`, `ledger_entries`.

Do not merge or deploy both proposed new ledger systems until one canonical ledger, ownership model, migration source of truth, balance calculation, posting/reversal API and reconciliation strategy are selected. Do not enable Supabase Auth and cookie sessions as parallel independent member identities without a deliberate mapping and lifecycle plan.

Migration ownership also conflicts: the Express migration runner consumes `server/migrations/*.sql`; PR #20 is a separate Supabase migration family. Establish one migration authority and explicit ordered deployment pipeline before applying either family.

## 6. Application route → data access map

This is a source-level route/repository mapping from PR #24 branch files. It identifies the tables visible in SQL in the named handlers and called repositories/services; it is not proof that every query in every indirect helper has been exhaustively mapped.

### Member routes — `server/routes-member.js`

| Route family | Tables / data access | Required boundary |
|---|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | `members`, `member_sessions`; auth repositories | Public rate-limited registration/login only; session creation/destruction server-only; never return password hash/session token. |
| Password reset request/complete | `members`, `password_reset_tokens`, `notification_outbox`, email delivery flow | Server-only; single-use hashed token, generic public response, revoke old sessions on reset. |
| `GET /membership-tier` | `members`, `accounts`, `transactions`, `membership_tier_history` | Own member only; tier recalculation server-side. |
| `GET /accounts`, `GET /transactions` | `accounts`, `transactions`, `ledger_entries` through member repository | Own member/account scope only; read-only response projection; never trust member ID from query/body. |
| `POST /transfers`, `POST /deposits` | `accounts`, `transactions`, `ledger_entries`, `approvals`, `idempotency_keys`, audit | Server-only mutation; limits, idempotency, risk and approval gates; posting must be atomic and audited. |
| `GET /card`, `POST /card/freeze`, `POST /card/test-purchase` | `cards`, `accounts`, `transactions`, `approvals` | Own card only; freeze is a server-side state change; test purchase explicitly sandbox/no funds. |
| Loan application list/create/information | `loan_applications`, `members`, `approvals` | Own application scope; create/response server-only; underwriting and funding separate, human-authorized workflows. |
| Money-request list/create/information | `money_requests`, `members`, `approvals` | Own request scope; create/update server-only; never interpret request as money movement. |
| Funding pool list/contribution | `funding_pools`, `funding_contributions`, `members`, `accounts`, `transactions` | Own contribution detail; pool discovery only approved/public fields; contribution posting requires separate authorization. |
| Notifications list/mark-read | `notifications`, `notification_outbox` | Own member read; mark-read own rows only; delivery worker server-only. |
| Support case list/create/detail/message | `support_cases`, `case_messages`, `members` | Member can read/write own cases only; operator access is separately scoped and audited. |
| AI chat/retry | `ai_tasks`, member context tables | Server-only model/provider calls; redact sensitive context; persist only authorized task records. |
| Privy wallet status/link/unlink | `member_privy_links`, `member_privy_wallets`, `members` | Server-only token verification and link lifecycle; member may see own sanitized status only. |

### Operator routes — `server/routes-operator.js`

| Route family | Tables | Required boundary |
|---|---|---|
| Operator login/logout/me | `operators`, `operator_sessions`, `audit_events` | Server-only; MFA and session controls required before production. |
| Teams/control/queue | `avcu_team_runtime`, `avcu_team_control_events`, `avcu_jobs`, `avcu_job_events`, `avcu_job_dead_letters`, `avcu_worker_heartbeats`, `avcu_service_identities` | Management read; super_admin-only control; append-only control event audit. |
| Approvals list/decide/assign | `approvals`, `transactions`, `accounts`, `loan_applications`, `money_requests`, `cards`, `members`, `audit_events` | Management review; decision server-only, separation of duties, reason, immutable audit and no self-approval. |
| Transaction reverse | `transactions`, `accounts`, `ledger_entries`, `approvals`, `audit_events` | Elevated permission, independent approval, compensating entry only; never delete/edit posted history. |
| Member and tier administration | `members`, `accounts`, `transactions`, `membership_tier_history`, `audit_events` | Least-privilege read; tier override requires reason and audit; sensitive member fields restricted. |
| Support cases/messages/status | `support_cases`, `case_messages`, `members`, `audit_events` | Operator assigned scope; management broader scope; auditor no write. |
| Email, AI, integration, loan alerts | `email_delivery_log`, `notification_outbox`, `ai_tasks`, `integration_health`, `loan_applications`, `operations_alerts` | Operational metadata only; payload/content and PII minimized; acknowledge actions audited. |
| Operators administration | `operators`, `operator_sessions`, `audit_events` | Super_admin only; no privilege self-escalation; dual control for sensitive role changes. |
| Migration validation/details | `migration_batches`, `migration_staged_transactions`, `audit_events` | Auditor and management read-only; validation server-only; applying/importing must be separately authorized. |
| Audit | `audit_events` | Auditor read-only; append by trusted server path only; no client UPDATE/DELETE. |

### Repositories and shared services

| Source | Tables observed in SQL |
|---|---|
| `server/repositories/auth.js` | `members`, `member_sessions`, `operators`, `operator_sessions` |
| `server/repositories/member.js` | `accounts`, `approvals`, `cards`, `case_messages`, `loan_applications`, `member_sessions`, `members`, `money_requests`, `notification_outbox`, `notifications`, `operations_alerts`, `password_reset_tokens`, `support_cases`, `transactions` |
| `server/repositories/operator.js` | `accounts`, `ai_tasks`, `approvals`, `audit_events`, `case_messages`, `loan_applications`, `members`, `membership_tier_history`, `migration_batches`, `migration_staged_transactions`, `money_requests`, `operations_alerts`, `operators`, `support_cases`, `transactions` |
| `server/services-member.js` | `accounts`, `cards`, `case_messages`, `idempotency_keys`, `support_cases`, `transactions` |
| `server/approvals.js` | `accounts`, `approvals`, `cards`, `loan_applications`, `members`, `money_requests`, `transactions` |
| `server/notifications.js` | `email_delivery_log`, `members`, `notification_outbox`, `notifications`, `password_reset_tokens` |
| `server/membership-tiers.js` | `accounts`, `members`, `membership_tier_history`, `transactions` |
| `server/job-queue.js` | `avcu_service_identities`, `avcu_jobs`, `avcu_team_runtime`, `avcu_job_events`, `avcu_job_dead_letters`, `avcu_worker_heartbeats` |

The SQL reference scan is lexical and can include false positives from SQL fragments/comments; it can also miss dynamic SQL and indirect calls. The route map must be completed with query-by-query call tracing and test coverage before release.

## 7. Proposed role/capability matrix

This is the target authorization design to implement and test, not an assertion that the current live database already enforces it.

| Data/action | Member | Support operator | Management | Auditor | Super admin | Worker | Trusted system |
|---|---|---|---|---|---|---|---|
| Own profile, accounts, transactions | Read own only | No by default | Narrow, justified support view | Read masked evidence | Break-glass only, audited | No | Server-mediated |
| Own support case | Read/create/reply | Assigned cases only | Scoped support cases | Read-only, case-sensitive access approval | Scoped emergency access | No | Notification/system workflow |
| Own card/loan/money request | Read/submit own request | Status/help only | Review/decision where authorized | Read-only | Exceptional oversight | Narrow job payload only | Server workflow |
| Financial posting/reversal | Propose request only | No | Approval only; no direct posting | No | Separate privileged authorization; never silent posting | No direct ledger write | Dedicated posting function/service only |
| Audit events | No | No | Read scoped | Read-only | Read-only | Append event through trusted worker API | Append-only |
| Operator accounts/roles | No | No | No | No | Manage with dual control | No | Provisioning only |
| Runtime queue/heartbeat | No | Queue summary only if needed | Read/monitor | Read-only operational evidence | Control teams | Own service/team job scope | Runtime control plane |
| Provider credentials/webhook payload | No | No | Metadata only | Redacted evidence | Secret manager admin outside DB | Scoped provider adapter only | Secret manager/provider adapter |
| Migration batches/staged rows | No | No | Review/validate | Read-only | Explicit import authorization | No | Controlled migration runner |

### Role semantics

- **Member:** authenticated identity maps to one immutable member ID. Client may read only own permitted records. All writes go through server routes and business rules.
- **Support operator:** assigned case scope only; no ledger posting, account balance adjustment, unrestricted member search or role administration.
- **Management:** operational review and approval within policy thresholds; no direct table-wide mutation or self-approval.
- **Auditor:** read-only evidence access, preferably masked/minimized; no approvals, support edits, operator changes or runtime controls.
- **Super administrator:** exceptional control-plane authority, not a routine financial posting role. Sensitive operations require step-up auth, reason, dual control where possible, and append-only audit.
- **Worker:** service identity scoped to one team, service and capability; job lease ownership enforced; no interactive member login; no general SQL table grants.
- **Trusted system:** narrowly scoped server-side operations, preferably explicit functions or repositories, separate credentials/roles per service. Never share service-role keys with browsers or ordinary workers.

## 8. Server-only, read-only, approval and immutable-audit classification

### Server-only

- Credential verification, password reset issuance/completion, session create/revoke.
- Member/operator provisioning and status changes.
- Any balance, ledger, card, payment, deposit, transfer, hold, settlement or reversal mutation.
- Provider webhook signature verification and provider event state transitions.
- Service identity registration, token rotation, queue leasing/acknowledgement, team control.
- Privy token verification and wallet linking.
- AI/provider requests involving member data.
- Migration validation/import, staged data reconciliation, and role/permission changes.

### Read-only projections

- Member own account/transaction/card/loan/money-request/support/notification views.
- Operator case queues, approval queues, integration health, queue health and loan alerts within scope.
- Auditor audit/migration evidence, with masking and explicit access purpose.
- Public product/jurisdiction/provider capability information only after legal/compliance approval.

### Approval gates

- Transfer/deposit above policy thresholds.
- Loan decision and any disbursement.
- Money movement, external payment submission, account restrictions/releases and reversals.
- Card issuance/activation and non-sandbox card operations.
- Migration imports, ledger corrections, provider route activation, jurisdiction/product capability activation.
- Operator privilege changes, service identity rotation and emergency access.

Approval must be independent from requester/initiator, amount- and action-scoped, time-bound, reasoned, idempotent, and recorded in immutable audit. The existing numeric limits in code are development policy constants, not approved financial institution policy.

### Immutable audit events

Record actor ID/type/role, authenticated session/service identity, action, target entity, timestamp, reason, request/correlation ID, approval reference, before/after digest or redacted diff, provider event ID where relevant, and outcome. Never store passwords, bearer tokens, full card data, raw secrets or unnecessary PII in audit metadata. Prevent UPDATE/DELETE by ordinary application roles and make audit reads themselves auditable for sensitive records.

## 9. Proposed table-by-table policy/grant matrix

**Legend:** R = read; C = create; U = update; D = delete. All client direct grants are proposed as none by default unless a narrowly reviewed read policy is explicitly selected. Server-side app access is through a non-owner, non-BYPASSRLS runtime role and pinned transactions; privileged routines use narrowly granted EXECUTE.

| Live table | Member | Support | Management | Auditor | Super admin | Worker/system |
|---|---|---|---|---|---|---|
| members | R own safe projection | R assigned/minimal | R scoped | R masked | R audited | C/U via provisioning service |
| member_sessions | none | none | none | metadata only | emergency metadata | C/U/D auth service only |
| password_reset_tokens | none | none | none | metadata only | emergency metadata | C/U/D auth service only |
| membership_tier_history | R own | none | R scoped | R masked | R audited | append via tier service |
| accounts | R own projection | none | R scoped | R masked | exceptional | server ledger only |
| transactions | R own projection | none | R scoped | R masked | exceptional | posting service only |
| ledger_entries | R own derived history only | none | R masked | R read-only evidence | exceptional | append-only ledger service |
| cards | R own safe fields | R status only | R scoped | R masked | exceptional | card service only |
| money_requests | R own | R assigned/minimal | R/C/U decision scope | R masked | exceptional | server workflow |
| funding_pools | R approved public fields | none | R/C/U admin scope | R | exceptional | contribution service |
| funding_contributions | R own | none | R scoped | R masked | exceptional | posting service |
| loan_applications | R own | R assigned/minimal | R/C/U review scope | R masked | exceptional | underwriting workflow |
| approvals | R own status only | none | R/C/U within assigned approval | R read-only | exceptional | create/transition service |
| support_cases | R/C own | R/U assigned | R/U scoped | R read-only masked | exceptional | support workflow |
| case_messages | R/C own | R/C assigned | R/C scoped | R read-only masked | exceptional | support workflow |
| notifications | R own; mark read via server | none | metadata only | none | exceptional | delivery service |
| notification_outbox | none | none | metadata only | R metadata | exceptional | worker only |
| email_delivery_log | none | metadata only | R metadata | R masked | exceptional | email worker |
| operators | none | own safe profile only | none | R minimal | C/R/U via dual control | provisioning service |
| operator_sessions | none | none | none | metadata only | emergency metadata | auth service |
| audit_events | none | none | R scoped | R read-only | R read-only | append only |
| operations_alerts | none | none | R/U acknowledge | R read-only | exceptional | worker/system |
| ai_tasks | own result only if exposed | none | R metadata | R redacted | exceptional | AI service |
| integration_health | none | none | R | R | exceptional | integration service |
| webhook_events | none | none | metadata only | R redacted | exceptional | webhook worker |
| idempotency_keys | none | none | none | metadata only | exceptional | server transaction only |
| migration_batches | none | none | R/validate | R read-only | approve import | migration runner |
| migration_staged_transactions | none | none | R masked/validate | R masked | approve import | migration runner |
| member_privy_links | own sanitized status only | none | metadata only | R masked | exceptional | Privy service only |
| member_privy_wallets | own sanitized status only | none | metadata only | R masked | exceptional | Privy service only |
| avcu_team_runtime | none | none | R | R | R/U control | runtime service |
| avcu_team_control_events | none | none | R | R | R; append control via control service | append-only runtime service |
| avcu_service_identities | none | none | metadata only | R metadata | manage via secret rotation | identity service only |
| avcu_jobs | none | queue summary only | R summary | R summary | exceptional | scoped lease/ack service |
| avcu_job_events | none | none | R | R | R | append-only worker service |
| avcu_job_dead_letters | none | none | R/requeue approval | R | exceptional | worker creates; controlled requeue |
| avcu_worker_heartbeats | none | none | R | R | R | worker writes own heartbeat |

This matrix is intentionally conservative. It must be converted into actual PostgreSQL roles, grants, RLS policies and tested server repository access. A role label alone is not a database principal. Prefer separate DB roles for member-facing app, operator app, read-only auditor, worker/service, migration runner and break-glass admin; do not give every role broad direct table grants.

## 10. Required test journeys

1. Anonymous user cannot read any member, session, account, transaction, ledger, card, loan, support, notification or operator data.
2. Member A can read only A's records and cannot infer B's identifiers, balances, transactions, cases, card or loan data through direct SQL or API ID substitution.
3. Member A cannot update account balance, ledger rows, approval decision, card state outside allowed request flow, membership verification, or another member's data.
4. Support operator can access only assigned cases and cannot read balances, full transaction history, credentials, card secrets or loan underwriting fields.
5. Management can review assigned business scope and approve only permitted actions; cannot self-approve, exceed policy or post directly.
6. Auditor can read approved masked audit/migration evidence but cannot mutate any row or invoke state-changing RPCs.
7. Super admin control is step-up authenticated, reasoned, audited and subject to dual control for role/financial-impact changes.
8. Worker can claim only its team's jobs with valid service identity/capability and lease; cannot read member tables or another team's jobs; stale lease cannot ack.
9. Provider webhook duplicate event is idempotent; altered payload for same provider/event ID is quarantined; unverified signature cannot be processed.
10. Journal posting rejects unbalanced per-asset/per-currency entries; posted entries are immutable; reversal is compensating and idempotent.
11. Connection-pool reuse cannot leak member/operator/system actor context between requests.
12. Migration runner rejects out-of-order, duplicate, partially applied or unauthorized migrations.
13. Public schema grants, sequence grants, function EXECUTE grants, default privileges and schema CREATE rights are verified, not just table RLS.
14. All tests run against disposable PostgreSQL roles/tables and actual application routes; production catalog remains read-only during testing.

## 11. Open defects and blockers

**Critical**
- Live project: 37/37 tables RLS disabled; 0 policies; anon and authenticated table privileges across all 37 tables.
- No proven production runtime role separation or full table/function/sequence/schema grant review.
- Existing app SQL uses cookie actor context; direct SQL outside validated request context and worker/system actor separation require full audit.
- Competing ledger designs (legacy, PR #16, PR #20) lack canonical source-of-truth decision.
- PR #16 new tables have no RLS/grant plan.
- PR #20 security-definer functions and service-role EXECUTE require full owner/search_path/schema CREATE/argument/actor-provenance review.

**High**
- PR #19/#20 Supabase Auth identity conflicts with cookie-session identity until lifecycle/mapping architecture is decided.
- PR #20 migrations use a separate Supabase migration family from Express migration runner.
- Route-to-table mapping is source-derived and needs complete indirect-call tracing, especially direct queries embedded in route files and helper modules.
- Auditor role is a server capability definition; database-level read-only enforcement and audited read access are not yet proven.
- Support assignment scoping, operator data minimization and dual-control approval need actual route tests.
- Existing development policy thresholds are not approved institutional policy.

**Medium**
- Full column sensitivity labels and exact live-vs-branch column/constraint/index diff are still required.
- Function grants, sequence grants, default privileges, schema CREATE rights, object ownership and SECURITY DEFINER review need complete catalog export.
- Audit event schema must be checked for actor provenance, tamper resistance, retention and read auditing.

## 12. Completion gates

The security matrix is complete only when all of these are true:

- [ ] Exact live catalog export includes columns, types, nullability, defaults, constraints, FKs, indexes, triggers, functions, owners, security-definer flags, function config, grants, sequence privileges, schema privileges, default privileges and RLS.
- [ ] PR #16 and PR #20 complete DDL is diffed against live and against each other, with explicit merge/retire decisions.
- [ ] Every route and SQL statement is traced to a repository/helper and table/operation; dynamic SQL is reviewed manually.
- [ ] Each table and sensitive column has a data owner, classification, actor scope and allowed operation.
- [ ] Each runtime principal has minimum required DB privileges; no browser service-role access.
- [ ] RLS policies and server-side permission checks are implemented and tested with non-owner, non-BYPASSRLS roles.
- [ ] Actual member/operator/worker/auditor journeys pass in disposable PostgreSQL integration tests.
- [ ] Negative tests prove cross-member, cross-team, cross-case, self-approval and direct-write denial.
- [ ] CI validates migrations from empty DB and upgrade path from the current schema.
- [ ] Independent security review signs off before any production migration or member data.

**Release status: NOT READY.** This document is an evidence-based first full matrix draft, not proof that the policies have been implemented. Do not merge, deploy, or run financial operations on the basis of this artifact alone.
