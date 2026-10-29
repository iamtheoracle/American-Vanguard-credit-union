# Staff-only external-wire confirmation queue

> **Design contract only.** This document defines the next implementation slice. It does not create a wire, connect to Goldenwest Credit Union, or authorize a staff member to claim that funds have moved.

## Scope

The queue is for receiving-bank evidence review after an external wire has been submitted through an authorized originating institution. It is not a wire initiation tool, bank portal, or ledger. Until an authorized provider and receiving-bank confirmation channel are integrated, all records are non-financial operational review records and must not alter balances.

The initial scenario is Kate Hirschi → Judith Anne Elizabeth Shearer, purpose House, planned amount 5,000.00, receiving institution Goldenwest Credit Union. Names and amounts are unverified demo values. Currency is unspecified. The scenario remains planned / not initiated.

## Roles and separation of duties

- **Wire evidence submitter:** authenticated staff member with the dedicated `wire_evidence_submitter` role. May create a case only after an originating provider reference exists and may attach a secure evidence pointer plus source metadata. Cannot approve or confirm recipient credit.
- **Wire confirmation approver:** authenticated staff member with the dedicated `wire_confirmation_approver` role. May inspect a submitted case and independently sourced evidence, then approve or reject it. Must have a different immutable Identity user ID from the submitter.
- **Wire operations administrator:** may view queue and audit history and manage case assignment. Must not bypass submitter/approver separation or directly set a recipient credited state.
- **Member:** cannot read or mutate staff evidence cases through this workflow.
- **Service identity:** future provider webhook identity only. It must be separately authenticated and cannot be impersonated by a staff browser request.

Do not treat the existing general membership `admin` role as sufficient permission to submit and approve the same wire. Dedicated roles must be provisioned out-of-band by an authorized identity administrator. Browser-supplied role names are never authoritative.

## Case lifecycle

1. `awaiting_evidence`: originating provider reference exists; recipient remains uncredited.
2. `evidence_submitted`: submitter records independently obtained Goldenwest channel/source metadata and a secure evidence pointer. Recipient remains uncredited.
3. `under_review`: a different approver claims the case for review. Claim is server-side and concurrency-safe.
4. `confirmed`: second reviewer approves evidence and beneficiary/amount/currency/reference match. This records a **confirmation event only**. It must not post to an American Vanguard ledger or claim that an unconnected Goldenwest account was programmatically updated.
5. `rejected`: approver rejects evidence with a reason. Recipient remains uncredited.
6. `escalated`: evidence is ambiguous, mismatched, stale, or cannot be independently verified. Recipient remains uncredited.
7. `returned_or_reversed`: only a separate authoritative provider/bank event or controlled investigation outcome may add this event. Never overwrite earlier history.

A case cannot jump from awaiting evidence to confirmed. A submitter cannot approve their own case. A reviewer cannot approve a case they submitted. A rejected case requires a new evidence submission and new review event; prior events remain immutable.

## Minimum data model

A future migration should create independent wire-review tables rather than add wire columns to membership application tables:

- `external_wire_cases`: UUID primary key; opaque originating-provider reference; sender and beneficiary display labels; receiving institution; amount as fixed-precision decimal; ISO currency code; purpose; provider-sourced originating status; recipient confirmation status; created/updated timestamps; creator identity ID; optional idempotency key with unique constraint.
- `external_wire_evidence`: UUID primary key; case ID; secure object-storage pointer; evidence source/channel; masked bank reference; amount/currency/beneficiary match outcomes; submitter identity ID; submitted timestamp; evidence hash; no raw credentials or full account/routing numbers.
- `external_wire_review_events`: append-only UUID primary key; case ID; evidence ID; reviewer identity ID; decision; reason; timestamp; immutable audit metadata. Enforce that reviewer ID differs from submitter ID in server transaction logic and, where possible, a database constraint/trigger.
- `external_wire_case_events`: append-only lifecycle events with actor/service identity, source, prior/new state, provider reference, timestamp, and correlation ID.

Use foreign keys, fixed-precision numeric amounts, ISO currency validation, indexes for queue status and timestamps, uniqueness for provider references and idempotency keys, and database transactions for state transitions. Never store bank login credentials, full account numbers, routing numbers, or statement images in ordinary database rows or application logs. Evidence files belong in private, access-controlled object storage with short-lived access and retention policy; store only an opaque pointer and cryptographic hash in the database.

Do not create or infer a Goldenwest balance. Do not add Judith to an American Vanguard ledger. An external-bank credit is confirmed only by an authorized receiving-bank/settlement integration or the approved independent manual evidence process.

## API contract

All endpoints must be server-side Netlify Functions. Every request must authenticate the Identity session, enforce dedicated roles, use same-origin/CSRF protection for browser mutations, apply rate limits, validate JSON schemas, return no-store responses, and emit structured audit events without sensitive payloads.

- `GET /api/admin/wire-confirmations`: operations/submitter/approver role-gated queue; return masked references and minimal metadata only.
- `POST /api/admin/wire-confirmations`: submitter-only evidence registration. Requires case ID, evidence pointer, source/channel, masked reference, amount/currency and match outcomes. Reject client-supplied reviewer, status, or credited flags.
- `POST /api/admin/wire-confirmations/:id/claim`: approver-only, atomic claim; reject if caller is submitter or another reviewer owns active claim.
- `POST /api/admin/wire-confirmations/:id/decision`: approver-only; requires claim ownership, a distinct reviewer identity, decision and reason. Approval records an immutable receiving-bank confirmation event, not a local account credit.
- `GET /api/admin/wire-confirmations/:id/events`: authorized audit-history read.

The server, not the browser, determines actor identity, role, allowed state transitions, timestamps, and audit metadata. No endpoint in this slice may call a payment/wire provider, debit an account, credit an account, or change a balance.

## UI contract

- Staff-only queue with clear states: Awaiting evidence, Evidence submitted, Under review, Confirmed by manual review, Rejected, Escalated.
- Detail view shows amount and currency only when supplied and validated, destination institution, masked provider/bank references, evidence source, submitter, assigned reviewer, timestamps, and audit history.
- Clearly distinguish “Goldenwest receipt independently confirmed by two staff reviewers” from “recipient account credited by bank.” The latter may only be shown after an authoritative receiving-bank confirmation.
- Disable the submitter's approve controls and prevent self-approval on the server even if the browser is manipulated.
- Never provide a “mark paid,” “credit Judith,” or arbitrary status override button.
- No evidence upload until private storage, file scanning, retention, access control, and secure retrieval are configured. Until then, accept only an opaque reference to an independently controlled evidence repository; do not accept public URLs.

## Required tests

- Unauthenticated, member-only, and generic-admin-only callers are denied.
- Dedicated submitter cannot approve; dedicated approver cannot approve own submission.
- Two concurrent claims cannot both succeed.
- Invalid transitions, missing currency, malformed amounts, and beneficiary/amount/reference mismatches are rejected.
- Browser cannot inject reviewer identity, timestamps, status, or a credited flag.
- Duplicate idempotency keys/provider references do not create duplicate cases.
- Evidence submission and decisions append audit events; previous events cannot be updated or deleted through application APIs.
- Rejection/escalation never marks the recipient credited.
- Manual confirmation does not create a local ledger posting or change a displayed balance.
- No provider call or wire initiation occurs in this feature slice.

## Release gates

Before enabling this queue in a deployed environment: review the actual Netlify Database schema and migration ordering; provision dedicated roles through an authorized admin; configure private evidence storage and retention; obtain compliance/security approval; run database-backed authorization, concurrency, audit-immutability, and end-to-end tests; and verify that all payment/wire capabilities remain disabled. A real wire additionally requires a contracted originating provider and an authorized receiving-bank confirmation channel.
