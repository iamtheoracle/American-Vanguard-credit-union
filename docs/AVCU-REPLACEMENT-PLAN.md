# AVCU replacement platform — consolidation and release plan

**Status:** Planning baseline; not production approval  
**Prepared from:** Repository and pull-request review on 2026-10-31  
**Target:** A new, independently operated AVCU digital platform that may replace the legacy public website only after institutional authority, technical readiness and customer continuity are verified.

## 1. Product direction

The existing public website is a research archive and institutional reference. It is not the design or technical blueprint for the replacement. The replacement must own its public information architecture, member experience, application workflows, operator experience, backend, database, authentication, integrations, security controls and deployment configuration.

Extract facts and approved assets from the legacy website, then verify them. Do not copy obsolete rates, contradictory dates, unsupported product claims, or unapproved branding. Every material institutional fact must have a source, retrieval date, effective date where applicable, verification state and reviewer.

## 2. Repository findings and consolidation decision

The default `main` branch is not the most advanced implementation baseline. The reviewed `feat/avcu-integration-hardening` branch compared as 232 commits ahead and 1 behind `main`. Its code includes an API-connected member/operator foundation, PostgreSQL migrations, ledger and approval foundations, notification outbox, sandbox integrations, Privy identity adapter, and a provider-independent AI layer.

Relevant feature pull requests identified during review:

- #17 — remove fabricated demo banking and correct identity/disclosures.
- #18 — read-only recorded account history in operator console.
- #19 — Supabase member authentication foundation.
- #20 — provider-independent banking foundation and jurisdiction controls.
- #21 — redesigned homepage, card/loan request flows and educational credit-readiness estimate.
- #14 — AI platform foundations and ECHO voice-notification architecture.
- #15/#16 — hybrid fiat/stablecoin architecture and asset-aware ledger foundation.

These changes are not automatically production-ready. Their PR descriptions explicitly identify outstanding reviews, database migration validation, provider approvals, production configuration and release gates.

**Consolidation rule:** Do not merge a stack of divergent branches blindly. First identify each PR's exact head/base SHA, merge order, dependency chain, overlapping files and migration order. Rebase or retarget only after reviewing conflicts and tests. Keep the replacement-readiness work on an isolated branch until reviewed.

## 3. Known implementation status (repository evidence)

| Area | Observed implementation | Remaining proof / work |
|---|---|---|
| Member identity | Registration/login/session and password reset code on the advanced line; separate Supabase auth preview branch | Choose one authoritative identity architecture; verify production tenant, sender, recovery, MFA and member provisioning |
| Member portal | Account, transaction, transfer/deposit request and notification interfaces | Connect to authoritative core/bank data; verify authorization, reconciliation and member records |
| Operator portal | Role-gated approval queues, support and audit foundations | Independent security review, role assignment process, operator MFA, audit retention and break-glass controls |
| Ledger | PostgreSQL ledger and approval foundations | Disposable/staging PostgreSQL tests, concurrency, available-funds checks, reconciliation, recovery and migration proof |
| Card products | Product catalogue/request flow on feature branch | Confirm actual issuer/programme and permissions; requests must not imply card issuance |
| Loans | Application and review records | Confirm products, rates, disclosures, underwriting authority and funding provider; application approval must not imply disbursement |
| Credit | Self-reported educational readiness estimate | Bureau data, score model and monitoring are not established; no estimate may be labelled a bureau score |
| Notifications | Persistent outbox and Gmail OAuth adapter | Verify approved sender, credentials, deliverability, consent, retries and bounce handling |
| AI | Provider-independent gateway, allowlisted tools and sandbox fallback | Verify configured production model, privacy, safety, logging and cost controls; no autonomous money movement |
| Wallet identity | Privy token verification and user lookup code | Verify existing account, app ID, scopes, production access and custody/signing model separately |
| Payments/cards adapters | Explicit sandbox adapters | No production rail or issuer connection proven by this code |
| Travel | No complete live provider integration established in inspected code | Research existing accounts/contracts before selecting flight, booking, map, lodging or experience suppliers |

The existence of source code, environment-variable names, sandbox health checks or a provider account is not proof of live production access. Never print or commit secrets. Audit configuration by checking presence and deployment scope only, then verify provider status through authorised dashboards or APIs.

## 4. Existing-provider access inventory

Create and maintain a machine-readable and human-readable inventory for every provider/capability. Record provider, product, business account owner, account verification, developer app ID (non-secret), production/sandbox status, approved scopes, agreement status, credential presence by environment (never the value), webhook status, last successful test, evidence link/date, owner and next action.

Use only these statuses:

- EXISTING ACCOUNT VERIFIED
- EXISTING PRODUCTION API ACCESS VERIFIED
- EXISTING API ACCESS — CONFIGURATION REQUIRED
- EXISTING INTEGRATION — REQUIRES TESTING
- EXISTING ACCOUNT — API ACCESS NOT CONFIRMED
- NEW PROVIDER ACCOUNT REQUIRED
- PROVIDER APPROVAL REQUIRED
- COMMERCIAL AGREEMENT REQUIRED
- NOT AVAILABLE
- LIVE AND VERIFIED

Check banking/core account services, payment processing, card issuing, credit bureaus, identity/KYC/AML, fraud, flight data, flight booking, navigation/maps, accommodation, travel booking, tours/experiences, notifications and customer support. Reuse suitable existing providers; do not create duplicate accounts or subscriptions. An absent repository secret is not sufficient evidence that no provider account exists.

## 5. Institutional knowledge extraction

Create a source register for all public pages and linked documents on the legacy website. Include company identity, history, membership eligibility, products, share/savings accounts, loans, cards, rates, fees, policies, terms, privacy, forms, application steps, office/contact details, notices, disclosures, approved logos and images.

For each extracted item store:
- Exact source URL or document title and retrieval timestamp.
- Extracted value/text and applicable page/section.
- Effective date and expiry/review date, if available.
- Verification status: VERIFIED, NEEDS CONFIRMATION, CONTRADICTORY, OUTDATED, or NOT FOUND.
- Destination page/component in the new platform.
- Reviewer and approval date.

Do not silently resolve contradictory rates, dates, eligibility or legal statements. Keep historical material labelled historical. Do not fabricate charter, insurance, licence, assets, membership counts, routing numbers, rates or partner relationships.

## 6. Customer experience and platform architecture

The replacement should provide one coherent customer experience with:
- Public institutional information and product discovery.
- Secure member authentication and account services backed by authoritative data.
- Membership, loan, card and service applications with clear eligibility, disclosures, evidence upload, status tracking and human support.
- Member notifications and secure messaging.
- Operator workflows with least-privilege roles, dual control where appropriate, immutable audit history and documented escalation.
- A provider directory and service transparency centre showing who supplies each service, what data is shared, booking/payment/refund responsibility, fees, terms and service status.
- Travel discovery and trip management only where licensed/authorised provider APIs or legitimate hand-offs are available.
- Accessibility, responsive design, clear errors, recovery and customer support across all journeys.

Third-party services must not be presented as AVCU-provided services when another provider is responsible. Flight data is not flight ticketing; a map is not a transport booking; accommodation discovery is not confirmed lodging; an application request is not approval or funding.

## 7. Jurisdiction and product controls

Preserve the repository's fail-closed jurisdiction/capability model. Do not enable onboarding, products, transfers or provider routes merely because a country exists in a registry. Enable only after legal eligibility, institutional authority, provider coverage, customer type, disclosures and operational support have been confirmed. Nigeria remains excluded from AVCU's supported service markets per project direction; do not infer ineligibility from nationality alone where a person lawfully resides in an eligible market.

## 8. Identity, authority and publication safeguards

The platform's intended institutional identity must be reconciled with the actual legal entity and documented authority to use its name, marks, customer information, domain and official communications. The repository's naming history contains conflicting labels. Do not publish or deploy as the official digital home of an existing institution until an authorised institutional representative confirms the mandate and the relevant production access.

No deposits, money movement, card issuance, credit decisions, loan funding, customer-data migration or production account opening may be enabled by this plan. Keep sandbox and preview functionality clearly labelled. Do not claim insurance, charter, licensing, regulatory approval or provider relationships without authoritative evidence.

## 9. Safe legacy-site replacement gates

Do not retire the legacy website until all gates are signed off:

1. Institutional authority, legal identity, domain control and publication approval confirmed.
2. Legacy-site inventory complete; important content and documents transferred, source-linked and approved.
3. New public site, member portal, application centre and operator console complete and accessible.
4. All essential customer journeys tested on mobile and desktop, including errors, support and recovery.
5. Existing member access and authoritative financial records mapped; migration is separately authorised, dry-run, reconciled and signed off.
6. Production providers and credentials verified in the correct environment; webhook signatures, scopes, reconciliation and monitoring tested.
7. Security, privacy, accessibility, disaster recovery, backup restoration and incident response reviewed.
8. Domain, TLS, DNS, URL mapping, redirects, analytics/privacy, support contacts and rollback plan verified.
9. Customer communications and operational staffing ready.
10. Explicit cutover approval from the authorised institution; retain required records and backups before controlled retirement.

A website cutover does not migrate core banking, customer credentials, balances, transaction records, card accounts or third-party contracts automatically.

## 10. Immediate engineering sequence

1. Freeze risky merges and deployments while branch ancestry is reconciled.
2. Build a PR/branch dependency map with exact SHAs and migration ordering.
3. Review and consolidate #17–#21 and relevant #14–#16 work into a single reviewed integration line; do not merge solely because a PR is open.
4. Establish a single canonical identity/auth architecture and resolve naming conflicts across README, UI, metadata, email templates, domains and disclosures.
5. Add the institutional source register and provider access inventory with evidence-backed statuses.
6. Validate every migration against a disposable PostgreSQL instance; run unit, API, security, accessibility and browser tests.
7. Implement missing customer journeys only after product rules and provider responsibilities are confirmed.
8. Run production readiness and old-site cutover gates; keep production financial operations disabled until independently authorised.

## 11. Acceptance criteria for this plan

This plan is complete only when the repository contains:
- A reconciled branch/PR dependency record and selected integration baseline.
- A source-linked institutional content register with unresolved items visible.
- A provider inventory with evidence and explicit unknowns.
- A customer journey coverage matrix.
- A migration and rollback plan.
- CI evidence for the selected baseline and database migrations.
- A signed-off release/cutover checklist.

**Current status:** this document records the review findings and required sequence. It does not certify that any provider is live, that company authority has been granted, or that the new platform is ready to replace the legacy website.
