# AVCU outbound domestic wire implementation

## Goal

Enable an authenticated AVCU member to request and, after all provider and institution approvals, send a domestic USD wire to an eligible US bank recipient. A saved request or operator approval is not a sent wire.

## Current repository behavior

- `POST /api/workflow` stores a `wire-transfer` request and requires an idempotency key.
- The member-facing request currently accepts only a receiving-institution name or non-sensitive reference. It deliberately rejects raw routing/account numbers.
- An operator approval currently sets an external request to `approved-awaiting-provider` with `provider_state=not-connected`.
- There is no Plaid API client, recipient bank-account tokenization/migration flow, provider webhook handler, provider reconciliation, or real wire submission in this repository.
- Therefore the current app cannot send a real wire yet. Do not label an approved request as submitted, processing, completed, or settled.

## Candidate provider: Plaid Transfer wire

Plaid's current documentation says:
- Wire is an early-availability payment network; request enablement from the Plaid account manager.
- Wire transfers are `credit` only (funds sent out from the platform); wire debits are not supported.
- Recipient setup requires the Plaid recipient Item migration flow and a `wire_routing_number`; the wire routing number must be collected from the recipient. Some tokenized account numbers cannot be used for wires.
- Wire requests are limited to USD 999,999.99 and have a 6:30 PM Eastern business-day submission cutoff.
- Transfer production access requires a business/use-case application and implementation approval.
- Plaid Transfer is US-only and is not intended for every money-transfer or marketplace model. Plaid must approve AVCU's actual legal entity, geography, counterparties, and use case before it is selected for production.

Official references:
- https://plaid.com/docs/transfer/creating-transfers/
- https://plaid.com/docs/api/products/transfer/initiating-transfers/
- https://plaid.com/docs/transfer/application/
- https://plaid.com/docs/transfer/

## Required implementation sequence

1. **Confirm program eligibility**: establish the legal entity operating AVCU, its authority/relationship to the named credit union, US business and control-person details, sponsoring bank/core relationship, and Plaid's written approval for the intended outbound-wire use case.
2. **Provision sandbox**: configure Plaid Sandbox credentials only as server-side Netlify environment secrets. Never commit secrets or accept them from the browser. Sandbox is simulated and cannot move real funds.
3. **Recipient onboarding**: build a provider-hosted/approved secure recipient setup flow. Collect recipient legal name, bank name, account number, and *wire* routing number only through an approved secure flow. Never put raw bank details in workflow rows, free-text fields, logs, analytics, or audit notes. Encrypt any provider access tokens at rest.
4. **Member authorization**: require authenticated member, verified identity, verified source of funds/available balance from the authoritative banking core, clear fee and delivery disclosures, step-up authentication, limits, and explicit confirmation.
5. **Dual control**: require an operator other than the requesting member to approve. Apply risk checks and sanctions/fraud screening before provider submission. Approval alone must not debit the ledger.
6. **Provider submission**: use server-side provider calls only, strict USD amount validation, provider authorization before creation, stable idempotency keys, and a durable mapping from AVCU request ID to provider transfer/authorization IDs. Never retry a non-idempotent create blindly.
7. **Webhook and reconciliation**: verify signatures against the raw body, enforce replay protection, deduplicate event IDs, lock rows, reject invalid state transitions, append immutable audit events, and reconcile provider reports against the authoritative core.
8. **Ledger posting**: do not create a debit or recipient credit from UI actions, HTTP success, or operator approval. Post only on authoritative core/provider evidence under the institution's ledger rules. Record returns/reversals as linked entries; never erase history.
9. **Certification**: test successful, declined, delayed, duplicate, out-of-order, returned, and webhook-replay cases in Sandbox; complete provider certification and independent security/compliance review before production.

## Required state model

- `pending-approval`: request saved; no provider instruction.
- `approved-awaiting-provider`: operator approved; provider not enabled/configured; no funds moved.
- `authorized`: provider authorization accepted; not yet submitted.
- `submitted`: provider confirms the wire instruction was submitted.
- `processing`: provider reports processing; not proof of recipient credit.
- `completed`: only when provider/core evidence meets the institution's final-settlement definition.
- `rejected` / `failed`: no completed transfer; release holds according to core rules.
- `returned`: record a linked return/reversal and applicable fees.

Map the provider's exact status vocabulary explicitly; never infer a final status from a generic success response.

## Production release blockers

- Written approval from the actual sponsoring institution and provider for the legal entity and exact use case.
- Provider-issued Production credentials and wire entitlement.
- Authoritative core account, available-balance, hold, debit, and reconciliation integration.
- Secure recipient collection/tokenization and account validation.
- KYC/CIP, AML, OFAC/sanctions, fraud, dispute, error-resolution, limits, disclosures, and customer-support procedures owned by the authorized institution/program.
- End-to-end certification, penetration/security review, incident response, and operations runbooks.

Until every blocker is satisfied, keep live wire submission disabled. The app may support a clearly labeled request/review workflow, but must not claim to send money or show a recipient as credited.
