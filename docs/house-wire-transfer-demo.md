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

## Acceptance criteria

- Demo UI labels all amounts as illustrative and the transfer as not initiated.
- Sender and beneficiary are displayed exactly as supplied, with a clear “unverified demo details” label.
- Currency is visibly marked as unspecified until configured; no currency symbol is guessed.
- Drafting or previewing the wire does not create a ledger entry or change any account balance.
- A real transfer cannot be submitted without verified sender authority, beneficiary details, currency, and explicit confirmation.
- For an internal transfer, sender debit and recipient credit commit atomically under one transfer ID; both histories reflect the same amount, currency, reference, and final status.
- A retry cannot create a second debit or recipient credit; a failed posting leaves neither side committed.
- For an external wire, the recipient side is not marked credited until the receiving institution or trusted settlement integration confirms receipt.
- The UI distinguishes draft, submitted, processing, completed, rejected, and failed states based only on trusted server/provider responses.
- Tests cover arithmetic, missing currency, missing or unverified beneficiary details, duplicate submissions, unauthorized access, and no ledger mutation during preview.

## Implementation prompt

Build a polished, accessible house-wire transfer experience for the American Vanguard Credit Union member portal. Treat all supplied values and names strictly as demo fixtures, not verified account data. Show **Kate Hirschi** as the sender and **Judith Anne Elizabeth Shearer** as the recipient, with the purpose **House**. Display a starting balance of **15,825.69**, a planned outgoing wire of **5,000.00**, and a projected post-transfer balance of **10,825.69**. Do not guess the currency; clearly show that it must be supplied and verified. Label the sender and beneficiary “Unverified demo details,” the wire “Planned — not initiated,” and the resulting balance “Projected — not posted.” Do not create a real transaction, call a payment API, modify a ledger, or imply that funds have moved. Build the flow so that a future production integration requires verified sender authority, authenticated beneficiary setup, currency confirmation, fee disclosure, step-up verification, idempotency, server-side authorization, immutable audit events, and provider-confirmed status reconciliation. Preserve the repository's current security boundary: this project is not connected to a banking core, so financial data must remain demo-only until an approved authoritative integration exists.
