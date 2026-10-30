# AVCU Hybrid Banking Architecture

**Status:** Architecture baseline — not production approval  
**Product:** America Vanguard Credit Union (AVCU)  
**Launch scope:** Personal and business banking  
**Operating model:** Hybrid — partner-bank fiat accounts plus separately governed stablecoin services

## 1. Product and legal boundary

AVCU is currently a software prototype. The repository's existing disclosure correctly states that it is not a chartered credit union, does not hold deposits, and does not move real money. Preserve that disclosure until legal status, sponsor-bank arrangements, contracts, and production permissions are independently verified.

The launch architecture has two custody domains:

1. **Fiat domain:** A regulated sponsor bank / banking-as-a-service arrangement holds customer funds in the legally documented account structure. AVCU maintains a reconciled customer subledger and user experience; it does not represent its internal database as the bank deposit itself.
2. **Digital-asset domain:** A separately approved custodian / virtual-asset provider provides custody and blockchain movement for supported assets and networks. Stablecoin balances are not bank deposits and must never be described as FDIC-insured unless a specific legal product structure and authoritative disclosure support that statement.

The two domains share identity, member experience, risk controls, and reporting, but never share an undifferentiated balance or custody ledger.

## 2. Launch products

### Personal
- Personal checking / share-draft account
- Personal savings account
- Member-to-member transfers
- External bank funding and withdrawals
- ACH credits/debits and domestic wires when enabled by the bank/payment partner
- Debit card only after a card issuer and processor approve and issue it
- USDC and USDT wallet balances only for approved assets, supported networks, eligible customers, and approved jurisdictions

### Business
- Business operating account
- Business reserve/savings account
- Business-to-business payments and supplier payouts
- Authorized users and role-based access
- Dual approval / maker-checker for configurable payment thresholds
- Employee cards only after issuer support and business underwriting
- Business statements, exports, and reconciliation references

Do not expose product controls as active until the corresponding provider capability and member eligibility are configured. A product request is not an issued account, card, wallet, or credit facility.

## 3. Core services

1. **Identity and onboarding:** Member authentication, KYC, business KYB, beneficial-owner checks, sanctions screening, eligibility, and periodic refresh.
2. **Account service:** Canonical AVCU account IDs mapped to provider customer/account references. Store only the minimum provider identifiers and masked display data.
3. **Fiat banking adapter:** Provider-neutral contract for account creation, funding instructions, ACH, wires, returns, holds, balances, and webhook events.
4. **Digital-asset adapter:** Provider-neutral contract for custody account provisioning, address assignment, deposit detection, compliance screening, withdrawal quotes/limits, transaction submission, confirmations, and chain reorg handling.
5. **Payment orchestrator:** Validates intent, eligibility, limits, approvals, available funds, idempotency, and provider routing. It owns the payment state machine, not provider custody.
6. **Ledger:** Immutable, balanced, asset-specific journal. Every journal transaction balances to zero within one currency/asset. Never net USD against USDC or USDT in one journal.
7. **Risk and approvals:** Member-bound authorization, step-up authentication, velocity/amount limits, sanctions/fraud decisions, business maker-checker, and manual review.
8. **Webhook inbox + transactional outbox:** Durable event intake, signature verification, deduplication, retryable processing, and provider reconciliation.
9. **Reconciliation:** Daily and intraday comparison of provider statements/balances/transactions against AVCU subledger and suspense accounts.
10. **Member reporting:** Available, pending, and posted balances; transaction details; receipts; statements; disputes and returns.

## 4. Ledger and balance rules

Use PostgreSQL as the authoritative AVCU operational subledger. Store monetary amounts as integer minor units or exact decimal strings according to asset precision; never use JavaScript floating-point arithmetic for money.

Introduce explicit concepts before real external movement:

- financial_accounts: owner, account type, currency/asset, provider mapping, status, and custody domain (fiat or digital_asset).
- journal_transactions: immutable reference, type, status, idempotency key, source event, and timestamps.
- journal_entries: account, asset, debit/credit direction, exact amount, and journal transaction.
- balance_holds: reserved amount, reason, linked payment, expiry/release state.
- external_payment_intents: rail, provider, destination token/reference, amount, fee, state, approval state, and provider payment ID.
- provider_connections: provider, environment, capability, status, configuration reference (never raw secrets), and health metadata.
- provider_events: provider + unique event ID, signature verification result, payload hash, processing state, and timestamps.
- reconciliation_runs and reconciliation_items: provider statement references, matched/unmatched amounts, discrepancy type, and resolution evidence.
- business_memberships and account_permissions: business owner, authorized users, roles, approval limits, and revocation history.

Balance definitions:

- **Posted ledger balance:** Sum of posted journal entries for one account and one asset.
- **Available balance:** Posted balance minus active holds and any policy-defined unavailable credits.
- **Pending credits:** Display separately; never spendable until the provider's authoritative settlement/availability event and risk policy allow it.
- **Pending debits:** Reserve funds before external submission when the rail/provider requires it.
- **Reversal:** Append compensating journal entries; never edit or delete posted financial history.

A provider webhook is not by itself sufficient to credit a customer unless its signature, event identity, event state, amount, asset, destination account, and provider-side transaction status are validated. Use provider API lookup or settlement reports where needed.

## 5. Payment lifecycle

Use a durable state machine with explicit transition validation:

created -> risk_review -> awaiting_approval -> reserved -> submitted -> processing -> settled

Terminal/exception states include rejected, failed, returned, cancelled, expired, reversed, and manual_review.

Rules:

- A request or approval is not a payment.
- A provider acceptance is not necessarily settlement.
- Do not mark an external transfer completed or credit the destination account until authoritative provider settlement/confirmation rules are satisfied.
- If a timeout makes provider submission uncertain, query by idempotency key/provider reference before retrying. Never blindly submit a second payment.
- Webhook retries and duplicates must be harmless.
- Returns, chargebacks, reversals, and chain reorgs use explicit compensating workflows.
- Keep provider raw payloads minimized, access-controlled, and retention-limited; store hashes and normalized fields where possible.

## 6. Provider strategy and capability gates

Provider names below are candidates, not selected or approved production integrations.

### Fiat

- Evaluate Increase as a banking API / sponsor-bank program candidate; the account registration started previously is not evidence of approval, underwriting completion, or production credentials.
- Evaluate a sponsor bank and program manager based on AVCU's actual legal entity, ownership, business model, geography, customer types, custody/FBO structure, and permitted products.
- Evaluate Modern Treasury for payment orchestration and operational controls. It is not itself the deposit-holding bank.
- Evaluate Moov as an additional payment-processing / money-movement candidate.
- Plaid may support account linking and bank-account verification where approved. Plaid linking/authentication must not be mistaken for ACH or wire execution authority.
- Card issuance requires a separate approved issuer/processor, BIN sponsorship, cardholder disclosures, authorization/clearing/settlement support, and program approval.

### Digital assets

- Evaluate Zero Hash for custody and stablecoin payment infrastructure.
- Verify separately whether USDC and USDT, the required networks, deposits, withdrawals, custody model, customer locations, and transaction types are supported under AVCU's proposed program.
- Do not enable USDT merely because USDC is supported, or assume the same network/fee/settlement behavior for both.
- Require compliance screening, Travel Rule applicability analysis, wallet/address risk controls, withdrawal policy, chain confirmation policy, and reconciliation.

### Production enablement gate

No live money movement until all of the following are evidenced:

- Executed provider and sponsor-bank agreements covering the exact product and customer flows.
- Completed underwriting and compliance approvals.
- Production credentials provisioned in a secret manager; never committed to Git or exposed to browser code.
- Approved account ownership, FBO/custody, disclosures, funds availability, and dispute/complaint responsibilities.
- Provider-supported test cases and operational runbooks.
- Verified webhook signatures, idempotency, reconciliation, incident response, and access controls.
- Legal/compliance review of the AVCU name, charter/credit-union representations, licensing, money transmission, custody, and marketing claims.

## 7. Security and authorization

- Keep provider secrets server-side and rotate any credential that has been exposed.
- Enforce member ownership checks on every account/payment lookup.
- Require step-up re-authentication bound to the exact immutable payment payload.
- Business payments support maker-checker: creator cannot be the sole approver above configured thresholds.
- Members authorize their own outgoing digital-asset transactions. AVCU policy enforces risk limits; administrators cannot silently move member assets.
- AI agents may explain, prepare, and propose payment actions, but cannot bypass member authorization, compliance checks, or human approval. AI proposals never post journal entries.
- Maintain append-only audit records for onboarding, access, approvals, payment transitions, provider events, adjustments, and reconciliation decisions.
- Apply rate limits, device/session controls, anomaly detection, least privilege, encryption, backups, recovery tests, and incident procedures.

## 8. Implementation sequence

### Phase 0 — Preserve and establish baseline
- Keep current prototype/demo disclosure and all live-money controls fail-closed.
- Reconcile active branches and draft PRs without blind merges.
- Fix the current failing CI run and obtain fresh green checks on the selected integration branch.
- Verify PostgreSQL migration behavior against a disposable database and confirm no production database is touched.
- Review the existing one-sided account-balance snapshot and ledger assumptions before extending the schema.

### Phase 1 — Account and ledger foundation
- Add asset/currency-aware financial accounts and immutable balanced journal tables.
- Add holds, suspense/clearing accounts, provider mappings, and account ownership constraints.
- Implement atomic journal posting, available-balance calculation, concurrency protection, idempotency, and compensating reversals.
- Add tests for double-entry balance, cross-asset isolation, insufficient funds, race conditions, replay, and rollback.

### Phase 2 — Personal + business product model
- Add personal and business account ownership models.
- Add business authorized users, roles, maker-checker approval policies, limits, and audit history.
- Upgrade dashboard APIs to show posted, available, pending, and held balances by account and asset.
- Add statements, transaction details, receipts, and product eligibility/status.

### Phase 3 — Fiat provider integration
- Select the bank/program partner after documented underwriting and capability review.
- Implement provider adapter and sandbox integration for account provisioning, funding instructions, ACH, wires, returns, and webhooks.
- Implement payment intent lifecycle, reserves/holds, settlement posting, reconciliation, and failure recovery.
- Add card issuer integration only after the banking partner and issuer confirm the supported card program.

### Phase 4 — Digital-asset integration
- Complete provider and jurisdiction capability review for USDC and USDT individually.
- Provision custodial accounts / customer wallet mapping through the approved provider.
- Implement deposit address assignment, deposit screening, confirmations, withdrawal authorization, fee disclosure, transaction monitoring, and chain reconciliation.
- Preserve member-bound approval and dual-control rules.

### Phase 5 — Production readiness
- Run staging end-to-end tests with provider-issued credentials.
- Validate webhook replay, out-of-order events, timeout uncertainty, provider outage, return, reversal, reconciliation mismatch, and recovery.
- Complete security, penetration, privacy, legal, compliance, and operations reviews.
- Enable production capabilities individually behind server-side feature flags after written approvals.

## 9. Release acceptance criteria

A feature is not live because a button or demo flow works. Mark each capability with one of:

- prototype: simulated/local-only behavior.
- sandbox: provider test environment only.
- approved_pending_credentials: contracts/approval evidenced, production credentials not yet active.
- production_enabled: authorized production connection, monitored and reconciled.

Before declaring a fiat or stablecoin product production-enabled, prove a complete round trip with provider evidence, corresponding balanced journal entries, correct available balance, member receipt, reconciliation match, and failure/reversal handling.

**Current known state:** The repository has a PostgreSQL API, member/operator portals, an integer-cent USD ledger, approval workflows, a sandbox payment adapter, a webhook inbox, and Privy identity-link support. The existing integration adapter is sandbox-only for payments/cards. Privy linking does not provision custody, sign, or broadcast transactions. The repository README must continue to state that no real deposits are held and no real money moves until the production gates above are satisfied.
