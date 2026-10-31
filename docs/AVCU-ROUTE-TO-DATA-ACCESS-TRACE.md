# AVCU route-to-data access trace (static audit)

**Audit basis:** repository snapshot `b189385ec1505986095ce7f971adfb57d00acc9c`, route files and service/repository modules fetched from GitHub.  
**Status:** preliminary static trace. This is not yet a complete runtime SQL trace or permission approval. Dynamic SQL, nested calls and route-specific branches require executable instrumentation tests.

## Route inventory

### Member API

| Method and path | Principal | Primary handler/dependency | Data domains observed |
|---|---|---|---|
| POST /auth/register | Public, rate-limited | memberRepo.registerMember; member lookup; tier calculation | members, accounts/tiers, notifications as downstream |
| POST /auth/password-reset/request | Public, rate-limited | findMemberByLogin; memberRepo.createPasswordReset | members, password_reset_tokens, notification_outbox/email |
| POST /auth/password-reset/complete | Public, rate-limited | memberRepo.completePasswordReset | password_reset_tokens, members, member_sessions |
| POST /auth/login | Public, rate-limited | findMemberByLogin; createMemberSession | members, member_sessions |
| POST /auth/logout | memberAuth | destroySession | member_sessions |
| GET /auth/me | memberAuth | authenticated request context | members/session |
| GET /membership-tier | memberAuth | recalculateMemberTier | members, accounts, transactions, membership_tier_history |
| GET /accounts | memberAuth | memberRepo.listAccounts | accounts |
| GET /transactions | memberAuth | memberRepo.listTransactions | transactions, accounts |
| POST /transfers | memberAuth | submitMemberTransfer; lookupIdempotent; notifications; tier | accounts, transactions, approvals, idempotency_keys, audit/notifications |
| POST /deposits | memberAuth | submitMemberDeposit; notifications; tier | accounts, transactions, approvals, idempotency_keys, audit/notifications |
| GET /card | memberAuth | memberRepo.getMemberCard | cards |
| POST /card/freeze | memberAuth | freezeCard | cards, audit_events |
| POST /card/test-purchase | memberAuth | testCardPurchase | cards, accounts, transactions; sandbox-only flow |
| GET /loans/applications | memberAuth | memberRepo.listLoanApplications | loan_applications |
| POST /loans/applications | memberAuth + verified membership | memberRepo.createLoanApplication | loan_applications, approvals, notification/outbox |
| POST /loans/applications/:id/information | memberAuth | memberRepo.submitLoanInformation | loan_applications, case/messages or application history |
| GET /money-requests | memberAuth | direct parameterized query | money_requests |
| POST /money-requests | memberAuth + verified membership | memberRepo.createMoneyRequest | money_requests, approvals |
| POST /money-requests/:id/information | memberAuth | memberRepo.submitMoneyRequestInformation | money_requests, application information history |
| GET /funding-pools | memberAuth | direct parameterized query | funding_pools |
| POST /funding-pools/:id/contributions | memberAuth | contribution workflow | funding_pools, funding_contributions, accounts/transactions, approvals |
| GET /notifications | memberAuth | memberRepo notification query | notifications |
| POST /notifications/mark-read | memberAuth | memberRepo notification update | notifications |
| GET /support/cases | memberAuth | memberRepo list | support_cases |
| POST /support/cases | memberAuth | createSupportCase | support_cases, case_messages, audit_events |
| GET /support/cases/:id | memberAuth | memberRepo detail | support_cases, case_messages |
| POST /support/cases/:id/messages | memberAuth | memberRepo message insert | support_cases, case_messages |
| POST /ai/chat | memberAuth + AI rate limit | runChat; task persistence | ai_tasks, member profile/context as applicable |
| POST /ai/retry | memberAuth + AI rate limit | task retry | ai_tasks |
| GET /wallets/privy/status | memberAuth | Privy status repository path | member_privy_links, member_privy_wallets |
| POST /wallets/privy/link | memberAuth | token verification and link | member_privy_links, member_privy_wallets |
| DELETE /wallets/privy/link | memberAuth | unlink | member_privy_links, member_privy_wallets |

### Operator API

| Method and path | Principal | Primary handler/dependency | Data domains observed |
|---|---|---|---|
| POST /operator/login | Public, rate-limited | operator credential lookup/session creation | operators, operator_sessions |
| POST /operator/logout | operatorAuth | session destruction | operator_sessions |
| GET /auth/operator/me | operatorAuth | authenticated operator context | operators, operator_sessions |
| GET /operator/teams | operatorAuth + team scope | team runtime service | avcu_team_runtime, control events |
| POST /operator/teams/:teamId/control | operatorAuth + permission/approval guard | team control service | avcu_team_runtime, avcu_team_control_events, audit_events |
| GET /operator/queue | operatorAuth + queue scope | job queue/repository | avcu_jobs, avcu_job_events, avcu_job_dead_letters, worker heartbeats |
| GET /operator/approvals | operatorAuth + approval scope | operatorRepo | approvals |
| POST /operator/approvals/:id/decide | operatorAuth + approval guard | approval decision workflow | approvals, transactions, loan_applications, money_requests, accounts, cards, audit_events |
| POST /operator/approvals/:id/assign | operatorAuth + approval scope | operatorRepo | approvals, operators |
| POST /operator/transactions/:id/reverse | operatorAuth + reversal guard | reverseTransaction | transactions, accounts, ledger_entries, approvals, audit_events |
| GET /operator/members | operatorAuth + member-read scope | operatorRepo | members |
| GET /operator/members/:id | operatorAuth + member-read scope | operatorRepo | members, accounts, transactions, cards, loans, money requests, support data |
| GET /operator/membership-tiers | operatorAuth | tier service | membership tier configuration |
| PUT /operator/members/:id/tier | operatorAuth + management scope | tier override | members, membership_tier_history, audit_events |
| DELETE /operator/members/:id/tier/override | operatorAuth + management scope | tier override removal | members, membership_tier_history, audit_events |
| GET /operator/members/:id/tier/history | operatorAuth | tier service | membership_tier_history |
| GET /operator/email-deliveries | operatorAuth + support/ops scope | operatorRepo | email_delivery_log |
| GET /operator/cases | operatorAuth + support scope | operatorRepo | support_cases |
| GET /operator/cases/:id | operatorAuth + support scope | operatorRepo | support_cases, case_messages |
| POST /operator/cases/:id/messages | operatorAuth + support scope | operatorRepo | support_cases, case_messages, notifications/outbox |
| POST /operator/cases/:id/status | operatorAuth + support scope | operatorRepo | support_cases, audit_events |
| GET /operator/ai-tasks | operatorAuth + AI oversight scope | operatorRepo | ai_tasks |
| GET /operator/integrations | operatorAuth + integration oversight scope | integration health | integration_health, webhook_events |
| GET /operator/operators | operatorAuth + operator-management scope | operatorRepo | operators |
| POST /operator/operators | operatorAuth + operator-management scope | operatorRepo | operators, audit_events |
| PATCH /operator/operators/:id | operatorAuth + operator-management scope | operatorRepo | operators, audit_events |
| GET /operator/loan-alerts | operatorAuth + lending oversight scope | operatorRepo | loan_applications, operations_alerts |
| POST /operator/loan-alerts/:id/acknowledge | operatorAuth + lending oversight scope | operatorRepo | operations_alerts, audit_events |
| GET /operator/migrations | operatorAuth + migration oversight scope | operatorRepo | migration_batches |
| POST /operator/migrations/validate | operatorAuth + migration approval scope | migration validation service | migration_batches, migration_staged_transactions |
| GET /operator/migrations/:id | operatorAuth + migration oversight scope | operatorRepo | migration_batches, migration_staged_transactions |
| GET /operator/audit | operatorAuth + audit scope | operatorRepo | audit_events |

The above is a route inventory and data-domain trace, not proof that every handler has exactly one SQL statement or that every downstream table was statically resolved. The exact query/operation/column mapping is the next instrumentation deliverable.

## Cross-cutting modules and direct data dependencies

| Module | Tables/data domains identified by static SQL scan | Security focus |
|---|---|---|
| repositories/auth.js | members, member_sessions, operators, operator_sessions | credential hash access, session ownership, revocation |
| repositories/member.js | accounts, approvals, cards, case_messages, loan_applications, member_sessions, members, money_requests, notification_outbox, notifications, operations_alerts, password_reset_tokens, support_cases, transactions | member_id predicates on every read/write; never trust caller-supplied member IDs |
| repositories/operator.js | accounts, ai_tasks, approvals, audit_events, case_messages, loan_applications, members, membership_tier_history, migration_batches, migration_staged_transactions, money_requests, operations_alerts, operators, support_cases, transactions | team/scope checks and least-privilege read models |
| services-member.js | accounts, cards, case_messages, idempotency_keys, support_cases, transactions | atomic transaction, idempotency, row locks, owner checks |
| approvals.js | accounts, approvals, cards, loan_applications, members, money_requests, transactions | maker-checker, limits, status transitions, approval evidence |
| notifications.js | email_delivery_log, members, notification_outbox, notifications, password_reset_tokens | no token/body leakage, dispatcher-only delivery rights |
| membership-tiers.js | accounts, members, membership_tier_history, transactions | member-scoped read; controlled tier writes |
| job-queue.js | avcu_service_identities, avcu_jobs, avcu_team_runtime, avcu_job_events, avcu_job_dead_letters, avcu_worker_heartbeats | purpose-specific worker identity, lease ownership/token, no arbitrary service impersonation |

## Immediate application-level issue found and fixed

The reviewed `server/index.js` called `migrate()` unconditionally in `startServer()`. That meant normal application startup could apply schema DDL, contradicting the selected single migration-authority design.

A feature-branch fix removes schema migration execution from API startup. Schema changes must be applied by the reviewed migration/deployment pipeline. The legacy migration runner is not yet removed; it remains a separately tracked retirement task and must not be invoked as part of production startup.

## Route-trace gaps that must be closed with runtime evidence

- Enumerate all SQL statements and CRUD operations per route, including indirect helpers, CTEs, triggers and SECURITY DEFINER function calls.
- Record exact column reads/writes, predicates, tenant/member scoping, and transaction boundaries.
- Trace every error/early-return path and verify request transaction commit/rollback.
- Prove member identity is derived only from validated session, never body/query/path input.
- Prove operator role and team scope are checked in handler and database layers.
- Identify routes that call a system/worker routine or use an unscoped pool connection.
- Add test instrumentation that records normalized SQL fingerprints and operation targets without logging sensitive parameter values.

## Required output of the next stage

Produce a machine-readable route-operation manifest with one record per route and one record per SQL statement:
`route_id, method, path, principal, auth_guard, handler, repository/helper, table_or_function, operation, columns, row_scope, transaction_boundary, approval_gate, audit_event, allowed_role, negative_test_id`.

Do not generate a production grant from lexical table references alone. Each grant must be justified by a verified route, service purpose or controlled migration operation.
