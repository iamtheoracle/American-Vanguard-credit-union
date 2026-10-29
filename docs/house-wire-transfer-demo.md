# House wire transfer — demo scenario and implementation brief

> **Demo/test data only.** These figures were supplied for a product scenario. They are not verified account data, a ledger entry, proof of available funds, or an instruction to send money.

## Scenario

- Displayed starting balance: **15,825.69**
- Planned house wire: **5,000.00**
- Projected balance after the planned wire: **10,825.69**
- Currency: **Not supplied — must be selected/verified before any real transaction**
- Transfer status: **Planned / not initiated**
- Destination: **House** (user-facing purpose label only; beneficiary and receiving-bank details are not specified here)

Arithmetic: 15,825.69 − 5,000.00 = 10,825.69.

## Product behavior

1. Show the starting balance only when retrieved from an authenticated, authoritative banking/core-ledger source. Until then, show these values only in a clearly marked demo state.
2. Present the 5,000.00 as a planned outgoing wire, never as completed, pending at the bank, or settled unless a real transfer provider confirms that state.
3. Show 10,825.69 only as a **projected** post-transfer balance. Do not mutate the ledger or available balance when a user merely drafts or reviews a wire.
4. Require currency, beneficiary identity, destination account details, fees, delivery estimate, and user confirmation before submitting a real wire.
5. Enforce server-side authentication, authorization, step-up verification, idempotency, limits, fraud controls, audit logging, and transaction-state reconciliation.
6. Never expose full account or routing numbers in logs, analytics, URLs, client-side source, or demo fixtures.
7. Keep this workflow disabled in production until a regulated banking/core provider, compliance review, security review, and end-to-end tests are complete.

## Acceptance criteria

- Demo UI labels all three amounts as illustrative and the transfer as not initiated.
- Currency is visibly marked as unspecified until configured; no currency symbol is guessed.
- Drafting or previewing the wire does not create a ledger entry or change any account balance.
- A real transfer cannot be submitted without all required beneficiary and currency details plus explicit confirmation.
- The UI distinguishes draft, submitted, processing, completed, rejected, and failed states based only on trusted server/provider responses.
- Tests cover arithmetic, missing currency, missing beneficiary details, duplicate submissions, unauthorized access, and no ledger mutation during preview.

## Implementation prompt

Build a polished, accessible house-wire transfer experience for the American Vanguard Credit Union member portal. Treat the figures in this document strictly as demo fixtures, not real account data. Display a starting balance of 15,825.69, a planned house wire of 5,000.00, and a projected post-transfer balance of 10,825.69. Do not guess the currency; clearly show that it must be supplied and verified. Label the wire as “Planned — not initiated” and the resulting balance as “Projected — not posted.” Do not create a real transaction, call a payment API, modify a ledger, or imply that funds have moved. Build the flow so that a future production integration can require authenticated beneficiary setup, currency confirmation, fee disclosure, step-up verification, idempotency, server-side authorization, immutable audit events, and provider-confirmed status reconciliation. Preserve the repository's current security boundary: this project is not connected to a banking core, so financial data must remain demo-only until an approved authoritative integration exists.
