# AVCU KYC, biometric verification and evidence handling

Status: implementation specification; sandbox provider integration is blocked pending AVCU's Trulioo sandbox tenant, approved service configuration and credentials. This document does not assert that Trulioo or Persona is contracted, enabled, or legally approved for AVCU.

## Product decision

- Primary provider adapter: Trulioo.
- Fallback adapter: Persona, activated only by an explicit compliance-controlled provider-routing decision. Never silently fail over a customer's biometric/document data to another processor.
- One AVCU-owned KYC case and state machine regardless of provider. Provider-specific IDs and results are mapped into a normalized internal model.
- Country and document availability are checked against a maintained, approved country capability matrix before offering a flow. “Global coverage” marketing is not proof of support for every document or check in every country.
- Current operating assumptions: US parent-company jurisdiction; Europe-wide intended scope, subject to country-by-country legal and provider approval; Nigeria excluded.

## Customer journey

1. Create a pending KYC case linked to the member/application; no financial account is activated.
2. Show a clear privacy notice describing the provider, data categories, purposes, biometric processing, recipients, retention, cross-border transfers, user rights and support route.
3. Record affirmative, versioned consent for each legally required purpose before biometric capture. Do not bundle optional product-improvement consent with required verification consent.
4. Collect only required identity attributes and select an allowed document type for the customer's country.
5. Create a provider transaction server-side. Return only a short-lived, single-use handoff/SDK token to the authenticated customer. Never expose provider client secrets.
6. Customer completes provider-controlled document capture and selfie/liveness flow. Trulioo documentation describes document capture, selfie verification and face matching; whether a true video recording is generated, returned or available for customer retention must be confirmed in AVCU's contract and selected product configuration. Do not promise video downloads until verified.
7. Receive provider callbacks through an authenticated, signature-verified webhook. Verify event authenticity, timestamp/replay window, transaction ownership and idempotency before state changes.
8. Retrieve authoritative result server-side. Normalize to pending, verified, rejected, review_required, expired, provider_error or cancelled. Preserve provider reason codes and a sanitized response snapshot.
9. Apply policy rules and route ambiguous/high-risk cases to trained compliance review. A provider “pass” is not by itself a legal account-opening approval.
10. Only a separate approved membership/account-opening workflow may advance the application after jurisdiction, sanctions/PEP, disclosures, eligibility and maker-checker controls are satisfied.

## Evidence storage and dashboard

### Storage principle

Use a dedicated private, encrypted evidence vault (object storage) rather than a shared drive, public bucket, ordinary application filesystem or email attachment. The vault must support encryption at rest, TLS, region-aware storage, malware scanning, immutable object versioning or tamper-evident hashes, retention/deletion policies, legal holds, access logging and backup controls.

Store only evidence AVCU is legally entitled and contractually permitted to retain. Prefer provider transaction references, signed result/report, document metadata, reason codes, timestamps and cryptographic hashes over retaining raw face templates, facial embeddings, selfie video or unnecessary document images. Trulioo's published biometric policy says facial scan data is not shared with the customer; retention and evidence availability are governed by the product terms and customer instructions. Confirm exact rights and retention in the executed agreement.

### Operator experience

Add a KYC Review workspace to the operator dashboard:
- queue filters: status, country, provider, risk/reason, age and assigned reviewer;
- case timeline: consent version/time, provider transaction, webhook events, status changes and reviewer decisions;
- evidence manifest: item type, provider/source, created time, retention expiry, hash and access classification;
- preview only where the operator role and evidence classification permit it;
- download evidence package only for explicitly authorized compliance roles, with step-up authentication, a required reason, short-lived download URL, watermark/case reference where feasible, and a durable audit event;
- no bulk download by default; no downloads for general support, management or auditor roles unless separately granted;
- auditor role remains read-only and should see metadata/audit trails by default, not raw biometric media;
- record every view, preview, export, denial, deletion and legal-hold action;
- exports must be encrypted, expire quickly and never be sent to a public URL.

### Access model

- Member: own case status and required next steps; no operator evidence access.
- Support: status-only and limited troubleshooting metadata.
- KYC reviewer: assigned cases and minimum necessary evidence.
- Compliance lead: case review, escalation, retention/legal hold and controlled evidence export.
- Auditor: read-only metadata and immutable audit records; evidence access only if separately authorized.
- System worker: narrow provider webhook/processing capability, no interactive dashboard.
- Super-admin: cannot bypass evidence access logging or retention controls.

## Proposed data model

- kyc_cases: id, member_id, application_id, country_code, status, risk_level, assigned_reviewer_id, provider_key, provider_transaction_id, created_at, updated_at, completed_at, retention_policy_id.
- kyc_consents: id, kyc_case_id, notice_version, purpose, consented, captured_at, locale, notice_hash, withdrawal_at.
- kyc_provider_events: id, provider_key, provider_event_id, kyc_case_id, event_type, received_at, signature_verified_at, payload_hash, processing_status, sanitized_payload; unique(provider_key, provider_event_id).
- kyc_results: id, kyc_case_id, provider_key, outcome, reason_codes, checks_json, provider_report_ref, received_at, normalized_at.
- kyc_evidence_objects: id, kyc_case_id, evidence_type, storage_key, provider_reference, content_type, byte_size, sha256, classification, created_at, retention_expires_at, legal_hold, deleted_at.
- kyc_reviews: id, kyc_case_id, reviewer_id, decision, reason_code, notes_redacted, created_at; maker-checker separation for overrides.
- kyc_evidence_access_events: id, evidence_object_id, actor_id, actor_role, action, reason, request_id, ip_hash, created_at, outcome.
- kyc_provider_routes: country_code, check_type, primary_provider, fallback_provider, enabled, effective_from, approved_by, approval_ref.

No raw identity numbers, document images, selfies or provider secrets should be copied into ordinary application logs, analytics, error trackers or audit metadata.

## Provider adapter contract

Implement a common interface:
- createVerification({caseId, subject, country, documentTypes, consentReference})
- createHandoff({caseId, transactionId, returnUrl})
- verifyWebhook({headers, rawBody})
- parseWebhook({event})
- fetchResult({providerTransactionId})
- fetchPermittedEvidence({providerTransactionId}) — returns only evidence explicitly exposed by the provider and permitted by contract; otherwise returns an explicit unavailable result.
- cancelVerification({providerTransactionId})

Trulioo adapter is primary. Persona adapter must implement the same contract and remain disabled until its sandbox is configured and compliance approves routing. Fallback is for provider outage/unsupported capability only, not to evade a failed identity decision or sanctions result.

## Security and operational requirements

- Keep all provider credentials in managed server-side secrets; separate sandbox and production credentials.
- Require webhook signature verification over the exact raw request bytes, replay protection, idempotency and strict transaction-to-case binding.
- Encrypt PII/evidence, use least-privilege storage IAM and database grants, and prevent path traversal/object-key guessing.
- Apply per-country retention schedules and deletion workflows; support legal holds and documented exceptions.
- Record consent before biometric processing and support consent withdrawal where applicable.
- Provide data-subject access/deletion workflows subject to statutory retention obligations.
- Do not store face embeddings or use biometric data for identification beyond the disclosed verification purpose.
- Test spoofing, replay, duplicate callbacks, out-of-order callbacks, provider timeouts, partial outcomes, manual review, unauthorized evidence access, expired download URLs and deletion.
- All KYC work remains sandbox-only until AVCU authority, jurisdictional legal review, provider contract, data-processing terms, security review and explicit production approval are documented.

## Sandbox acceptance tests

1. US and each approved European country have explicit supported ID/check matrices; unsupported country/document combinations are blocked before provider transaction creation.
2. Consent absent/withdrawn/old notice version prevents biometric transaction creation.
3. Provider secrets never reach browser responses or logs.
4. Invalid signature, stale timestamp, replay and mismatched transaction callbacks are rejected and audited.
5. Duplicate events are idempotent; conflicting payloads are quarantined for review.
6. Provider results are normalized without converting inconclusive/error into verified.
7. Fallback is never automatic on a failed or adverse verification result.
8. Only assigned KYC reviewers/compliance roles can access classified evidence; all evidence access and downloads are audited.
9. Evidence download is denied without step-up auth and reason; generated links expire and are single-purpose.
10. Retention expiry deletes eligible objects and records deletion evidence; legal hold blocks deletion.
11. Account activation remains blocked unless the independent membership approval gates pass.
12. Provider outage, partial match and manual-review journeys remain recoverable without duplicate cases or lost audit history.

## External references

- Trulioo KYC person verification API: https://developer.trulioo.com/reference/identity-verification-verifications
- Trulioo KYC Documents SDK: https://docs.verification.trulioo.com/
- Trulioo transaction API (document, selfie liveness and face-match configuration): https://developer.trulioo.com/reference/posttransactions
- Trulioo privacy policy: https://www.trulioo.com/services-privacy-policy
- Trulioo facial scan and biometric information policy: https://www.trulioo.com/biometric-information-policy

## Open integration prerequisites

- Trulioo sandbox tenant and server-side credentials, delivered through the approved secrets manager (never pasted into GitHub or chat).
- Confirmation of the exact Trulioo product/API version, enabled country/document/check matrix, webhook signing method, report/evidence export rights, retention terms and whether any video file is actually available to AVCU.
- Persona sandbox tenant/credentials and equivalent coverage/retention terms before enabling fallback.
- AVCU's approved legal entity, operating-country list, compliance owner, privacy notice and retention schedule.


---

## AVCU-owned identity governance implementation (2026-10-31)

The governing architecture is AVCU-owned. External verification providers are optional evidence sources and must never be the system of record or the owner of member identity data, disclosure permissions, or audit history.

### Implemented in this branch
- Added `20261104_avcu_identity_governance.sql` for AVCU identity profiles, verification sessions/check records/decisions, source approvals, evidence manifests, scoped operator assignments, access grants, disclosure requests/fields/events, retrieval events, and retention actions.
- Added `server/identity-governance.js` and mounted it in the API.
- Added member-owned identity profile and disclosure-history endpoints.
- Added operator disclosure request workflow with a strict field allowlist, named recipient person and legal entity, purpose, legal basis, authority reference, channel, expiry, reason, and two-person approval (requester cannot approve their own request).
- Added management-only assignment and revocation endpoints with narrow scopes and expiry. Ordinary operators are restricted to assigned cases; auditor role is excluded from KYC case detail routes.
- Disclosure approval is not release. No external transfer endpoint is enabled until private-vault retrieval, recipient authentication, step-up authentication, field-level release authorization, transfer receipts and downstream deletion controls are implemented and tested.

### Explicitly not represented as complete
- The private encrypted object-storage adapter, KMS envelope encryption, secure evidence retrieval/export, step-up authentication, actual document authenticity engine, independent liveness/anti-spoofing component, face-match attestation, and authoritative source adapters remain implementation work.
- No proprietary biometric algorithm or government-database connection is claimed.
- The initial country allowlist remains US by default. Additional countries require country-specific source coverage, legal and operational approval.
- This branch does not activate live KYC, customer onboarding, account opening, cards, lending, or money movement.

### Mandatory next controls
1. Validate migration against the exact deployment schema and disposable PostgreSQL.
2. Add route-level integration tests for member isolation, assignment scope, two-person disclosure approval, expiry, revocation, and append-only disclosure events.
3. Implement a private encrypted evidence vault with KMS-backed envelope encryption and no public bucket/object access.
4. Implement step-up authentication and short-lived, case-bound retrieval grants; log every preview, retrieval, export and denial.
5. Implement the internal verification orchestration engine and source capability matrix; only claim a check is passed when supported by validated evidence.
6. Complete security, legal, provider/source and operational approvals before production activation.
