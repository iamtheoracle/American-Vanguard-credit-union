# AVCU production-readiness implementation plan

## Current verified repository state

The current `main` branch is a browser-only fictional banking demonstration. It stores demo state locally and has no member authentication, server API, connected core-banking system, payment provider, or settlement capability. The app's existing demo disclosures must remain until the real institutional, provider, and operational prerequisites are independently verified.

This document is an implementation specification, not a claim that these controls are already implemented or that AVCU is authorized to provide financial services.

## 1. Member status notifications

- Send an email when an operator changes a money request to approved or rejected.
- Send an immediate internal alert when a loan application is submitted.
- Use a transactional email provider or an explicitly authorized Gmail integration with least-privilege access; do not collect or store Gmail passwords.
- Persist notification jobs and delivery outcomes; retry transient errors safely and deduplicate by event ID.
- Do not expose sensitive account or loan details in email subject lines. Link recipients to authenticated pages.
- Keep an in-app notification as the durable fallback when email delivery fails.

## 2. Membership tier dashboard

- Display a member's current tier, next tier, progress, and effective date.
- Load qualification requirements from versioned server-side configuration.
- Show each active requirement, the member's current value, the target, and how progress is calculated.
- Recalculate on trusted server events; do not let a client edit its tier or qualification data.
- Make tier changes auditable and explain any manual override.

## 3. Funding pools / investor area

- Treat pools as informational until the organization is legally authorized and approved disclosures and contracts are available.
- Display target, verified contributions, closing date, eligibility, risks, fees, and legally reviewed return assumptions.
- Never promise or imply guaranteed returns. Label projections as estimates and disclose loss risk.
- Do not accept contributions or represent funds as invested until an authorized custodian/payment provider, compliance checks, ledger controls, and reconciliation are live.
- For the current demo, use clearly synthetic data and disabled contribution actions.

## 4. Loan workflow and role permissions

Use server-enforced role-based access control, not hidden UI buttons alone.

- Operator: review submitted applications, request information, and record a recommendation; no final approval unless explicitly delegated by policy.
- Management: approve/reject within documented limits and review operator recommendations.
- Super-admin: manage access and workflow configuration; any ability to approve a loan must be separately permissioned and audited.
- Separate submitter, reviewer, approver, and poster where feasible. Require a second approver for policy-defined high-risk/high-value cases.
- Use explicit states: submitted, under_review, information_required, recommended, approved, rejected, cancelled, and disbursed. Disbursement must remain unavailable until the authorized financial integration is live.
- Enforce allowed state transitions, optimistic concurrency, and idempotency server-side.

## 5. Operations audit log

Append immutable audit events for every view of restricted records where required, review, comment, status transition, approval, rejection, override, export, and migration action. Record actor ID, role, entity ID, action, before/after values or a safe diff, UTC timestamp, correlation/request ID, and reason. Restrict access, redact secrets, and protect logs against alteration.

## 6. Legacy account and transaction migration

- Obtain authorized source exports or source-system access and document field mappings before importing.
- Preserve source account/member identifiers as references and retain original transaction IDs, timestamps/time zones, descriptions, amounts, currency, status, and reversals.
- Import into staging first; validate formats, record counts, duplicates, missing fields, currency precision, and opening/closing balances.
- Use deterministic idempotency keys and a restartable import process. Never silently discard a row or invent a missing transaction.
- Produce exception reports and reconciliation totals by account, currency, date range, and transaction status.
- Obtain authorized sign-off before cutover; retain a protected source archive and tested rollback plan.
- Never migrate passwords in plaintext. Require password reset or a supported secure identity migration.

## 7. Production acceptance gates

Do not represent the platform as live or verified until all gates pass:

1. Institutional authority, legal review, privacy obligations, and applicable compliance controls confirmed.
2. Production authentication, MFA for privileged users, account recovery, and server-side authorization tested.
3. Approved core-banking/payment provider connected in its production environment with secrets stored outside source control.
4. Ledger invariants, transaction idempotency, reconciliation, reversal, and failure recovery tested.
5. Migration dry run reconciled with zero unexplained differences; exceptions signed off.
6. Notification delivery, retries, deduplication, and failure alerts tested.
7. Audit log access and tamper protection verified.
8. Security review, backups, disaster recovery, monitoring, incident response, and release sign-off completed.

## Acceptance test examples

- A loan submission creates exactly one internal alert even when the client retries.
- Approval/rejection sends one email to the verified member address and records delivery status.
- Unauthorized roles cannot approve/reject by calling the API directly.
- Every successful or denied workflow action creates the required audit event.
- Re-running a migration batch does not duplicate accounts or transactions.
- Source-to-target transaction counts and signed totals reconcile; every discrepancy is blocked or explicitly approved.
- No real-money action is available while the production provider and required authorization are absent.
