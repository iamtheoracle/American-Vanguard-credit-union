# House wire transfer — demo scenario and implementation brief

> **Demo/test data only.** These figures and party names were supplied for a product scenario. They are not verified account data, a ledger entry, proof of available funds, or an instruction to send money.

## Scenario

- Sender / originating account holder (user-supplied): **Kate Hirschi**
- Recipient / beneficiary (user-supplied): **Judith Anne Elizabeth Shearer**
- Transfer purpose: **House**
- Displayed starting balance: **15,825.69**
- Planned outgoing wire: **5,000.00**
- Projected balance after the planned wire: **10,825.69**
- Currency: **Not supplied — must be selected and verified before any real transaction**
- Receiving institution: **Goldenwest Credit Union**
- Transfer status: **Planned / not initiated**

Arithmetic: 15,825.69 − 5,000.00 = 10,825.69.

The sender and beneficiary names are user-provided labels only. Verify legal names, account ownership, beneficiary instructions, and destination details through an authorized banking process before any real transfer. Do not infer that the beneficiary owns or controls a previously mentioned account.

## Product behavior

1. Show the starting balance only when retrieved from an authenticated, authoritative banking/core-ledger source. Until then, show these values only in a clearly marked demo state.
2. Present the 5,000.00 as a planned outgoing wire from Kate Hirschi to Judith Anne Elizabeth Shearer for the stated house purpose. Never represent it as submitted, completed, pending at the bank, or settled unless a trusted provider confirms that state.
3. Show 10,825.69 only as a **projected** post-transfer balance. Do not mutate the ledger or available balance when a user merely drafts or reviews a wire.
4. Require currency, verified sender authority, beneficiary identity, destination account details, fees, delivery estimate, and explicit user confirmation before submitting a real wire.
5. Enforce server-side authentication, authorization, step-up verification, idempotency, limits, fraud controls, audit logging, and transaction-state reconciliation.
6. Never expose full account or routing numbers in logs, analytics, URLs, client-side source, or demo fixtures.
7. Keep this workflow disabled in production until a regulated banking/core provider, compliance review, security review, and end-to-end tests are complete.

## Sender and recipient account reflection

For an eventual **internal transfer between accounts on the same ledger**, a completed transfer must be recorded as one atomic, balanced ledger operation: debit the sender and credit the recipient for the same amount and currency, using one shared transfer ID. Both account histories must show the matching transfer reference, amount, currency, timestamp, counterparty, purpose, and final status. The sender's balance decreases and the recipient's balance increases only when the ledger transaction commits. If either posting fails, neither posting may remain committed. Enforce idempotency so retries cannot debit or credit either side twice, and verify that the authenticated sender is authorized to debit the source account and that the recipient account is valid and eligible to receive funds.

For an **external bank wire**, do not credit a recipient wallet/account merely because the sender submitted the wire. Record the outgoing instruction and any provider status separately; reflect an incoming credit only when the receiving institution or an authorized settlement/ledger integration confirms receipt and supplies a trustworthy posting reference. Do not assume that an external recipient account is part of this application's ledger.

These are future production requirements only. This repository currently has no connected banking core or authoritative account ledger, so the present scenario remains planned demo data and must not create either side of a real posting.

## Receiving institution: Goldenwest Credit Union

The recipient's destination institution for this scenario is **Goldenwest Credit Union** (user-supplied). This is an external-bank wire, not an internal American Vanguard wallet transfer. Do not create or display a local Goldenwest account balance in this application and do not claim that Judith's account has been credited based only on sender-side submission or an outgoing-wire receipt.

### Initial operating mode: manual receiving-bank confirmation

Until an approved Goldenwest integration exists, use a controlled manual review workflow. Manual review is an operational verification step, not a substitute for a bank integration and not permission to initiate a wire.

1. Keep the wire in **planned / not initiated** until the originating bank's authorized wire workflow is available and the sender has explicitly approved the complete instruction.
2. After an actual wire is submitted through an approved originating institution, record only its provider-issued reference and provider-sourced status. Do not allow a staff member to type a status that impersonates a provider event.
3. Keep the recipient state **awaiting receiving-bank confirmation**. A sender receipt, transfer screenshot, email forwarded by the sender, or verbal assurance is not sufficient proof that Judith's account was credited.
4. A designated operations reviewer must obtain confirmation through an independently verified, authorized Goldenwest channel or an approved bank statement/settlement feed. Do not use contact details supplied only in an unverified transfer request.
5. Require a second authorized reviewer to approve the evidence and beneficiary match before recording a recipient-credit-confirmed event. The person who submits or uploads evidence must not be the sole approver.
6. Store only the minimum necessary evidence metadata: source/channel, reviewer identities, timestamps, masked reference, amount/currency, beneficiary match result, and a secure evidence pointer. Do not store online-banking credentials, full account numbers, or sensitive statement contents in application logs.
7. If confirmation is unavailable, inconsistent, or ambiguous, leave the recipient state awaiting confirmation and escalate through the institution's verified contact channel. Never infer success from elapsed time.
8. Record confirmation as an append-only audited event. Corrections, returns, reversals, and disputes must be separate events with reason, actor, time, and supporting reference; never silently rewrite history.

### Future automated mode

Replace manual confirmation only after a formal, authorized Goldenwest or settlement-provider integration is contracted, credentials are securely provisioned, webhook/API signatures and replay protection are validated, and reconciliation tests pass. Automated events must be authenticated, idempotent, traceable to a provider reference, and distinguish pending, posted, rejected, returned, and reversed states. Do not simulate this integration with mock callbacks in production.

### Required external-wire lifecycle

1. Validate Kate's authority to initiate the wire and verify the beneficiary and destination instructions through the authorized originating-bank workflow. Do not assume previously mentioned account details belong to Judith.
2. Submit only through an approved originating-bank wire provider after currency, fees, limits, step-up authentication, fraud checks, and explicit confirmation are complete.
3. Record the originating-side instruction and provider reference with states sourced from the provider (for example submitted, processing, completed, rejected, or returned). A sender-side completed/settled state must follow the provider's defined settlement semantics.
4. Show an incoming credit on Judith's Goldenwest account only when Goldenwest or an authorized receiving-bank/settlement integration confirms the receiving account was credited. Under the initial manual mode, require the two-person evidence review above. Otherwise show **awaiting receiving-bank confirmation**, not credited.
5. Reconcile amount and currency, beneficiary, both provider references, timestamps, fees, and final outcome. Handle returns, reversals, and investigations as separate audited events; never silently rewrite history.
6. Keep the sender's outgoing wire record and recipient's confirmed incoming record linked by a shared correlation/reference ID where the institutions provide one. Never invent a Goldenwest confirmation or recipient transaction.

This repository currently has no connection to American Vanguard's core ledger, an originating wire provider, or Goldenwest Credit Union. Therefore this scenario remains illustrative and no live wire or receiving-account credit can be performed from this application.

## Acceptance criteria

- Demo UI labels all amounts as illustrative and the transfer as not initiated.
- Sender and beneficiary are displayed exactly as supplied, with a clear “unverified demo details” label.
- Currency is visibly marked as unspecified until configured; no currency symbol is guessed.
- Drafting or previewing the wire does not create a ledger entry or change any account balance.
- A real transfer cannot be submitted without verified sender authority, beneficiary details, currency, and explicit confirmation.
- For an internal transfer, sender debit and recipient credit commit atomically under one transfer ID; both histories reflect the same amount, currency, reference, and final status.
- A retry cannot create a second debit or recipient credit; a failed posting leaves neither side committed.
- For an external wire to Goldenwest Credit Union, Judith's receiving-account side is not marked credited until Goldenwest or an authorized receiving-bank/settlement integration confirms the actual posting.
- In the initial manual mode, recipient-credit confirmation requires independently sourced bank evidence and two distinct authorized reviewers.
- The UI clearly distinguishes originating-bank submission/settlement from receiving-bank credit confirmation and preserves both references where available.
- No local American Vanguard balance is invented for Judith's Goldenwest account.
- The UI distinguishes draft, submitted, processing, completed, rejected, and failed states based only on trusted server/provider responses or approved audited operations events.
- Tests cover arithmetic, missing currency, missing or unverified beneficiary details, duplicate submissions, unauthorized access, no ledger mutation during preview, reviewer separation, and rejection of unverified evidence.

## Implementation prompt

Build a polished, accessible house-wire transfer experience for the American Vanguard Credit Union member portal. Treat all supplied values and names strictly as demo fixtures, not verified account data. Show **Kate Hirschi** as the sender and **Judith Anne Elizabeth Shearer** as the recipient, with the purpose **House** and destination institution **Goldenwest Credit Union**. Display a starting balance of **15,825.69**, a planned outgoing wire of **5,000.00**, and a projected post-transfer balance of **10,825.69**. Do not guess the currency; clearly show that it must be supplied and verified. Label the sender and beneficiary “Unverified demo details,” the wire “Planned — not initiated,” and the resulting balance “Projected — not posted.” Do not create a real transaction, call a payment API, modify a ledger, or imply that funds have moved. For the initial external-wire operating model, implement a controlled manual receiving-bank confirmation queue with independent evidence sourcing, two-person approval, masked references, and append-only audit events; do not mark Judith credited until verified Goldenwest confirmation is recorded. Preserve the repository's current security boundary: this project is not connected to a banking core or wire provider, so financial data must remain demo-only until approved authoritative integrations exist.
