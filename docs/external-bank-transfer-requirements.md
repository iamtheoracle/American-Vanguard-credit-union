# External bank transfers — implementation contract

This branch currently records external wire/payment requests for operator review. It does not connect to a banking core, ACH operator, wire network, or receiving bank. An approval is not a payment instruction and must never debit an account or create a recipient credit.

## Required member flow

1. Collect recipient legal/account name, receiving institution, supported rail (ACH or domestic wire), amount, currency, and an optional memo.
2. Collect account/routing details only through the banking provider's secure account-tokenization or hosted collection flow. Do not store raw account/routing numbers in AVCU workflow rows, browser storage, logs, audit notes, or analytics.
3. Validate account/routing details using the provider's bank-directory and account-validation service where available. A name typed by the sender is not verified identity.
4. Create an idempotent transfer instruction with a provider-generated reference. Keep it in a non-posted state until provider events confirm the actual debit/settlement.
5. Display the sender's debit only when the core/provider confirms the debit. Display recipient delivery only when the provider supplies a receiving-bank acceptance/credit event or equivalent final settlement status.
6. Reconcile provider reports against the AVCU ledger. Handle duplicate, delayed, out-of-order, returned, rejected, and reversed events.

## Receiver-side outcome

The recipient does not need an AVCU membership. The funds must be addressed to their existing account at any institution supported by the connected provider and selected rail. The receiving institution controls whether it displays an incoming item as pending. AVCU may show a sender-side pending state, but must not claim that every receiving-bank app will display a pending credit.

## Canonical status mapping

| Provider evidence | AVCU status | Ledger treatment |
| --- | --- | --- |
| Request saved; no provider instruction | Pending approval | No posting |
| Operator approved; provider not connected | Approved · Awaiting Provider | No posting |
| Provider accepted instruction | Processing | No final posting |
| Provider reports receiving-bank acceptance / final settlement | Completed | Post only the confirmed sender debit and any confirmed receiver credit in the institution's authoritative ledger |
| Provider rejects before settlement | Failed | No recipient credit; release any hold according to core rules |
| Provider returns or reverses settled funds | Returned | Record a linked reversal; never erase the original entry |

A provider's status vocabulary must be mapped explicitly. Do not map HTTP success, request submission, operator approval, or an ACH file acceptance to recipient-side posted/settled.

## Human-readable transaction descriptions

Descriptions are deterministic templates populated from verified provider/core fields, for example:

- `Sent money to {verified_recipient_name} — {receiving_bank_name}`
- `Received transfer from {verified_sender_name} — {sending_bank_name}`
- `External bank transfer returned — {verified_recipient_name}`

If the provider does not verify a counterparty name, use a neutral description such as `External bank transfer`. Keep a user-entered memo separate from the verified counterparty.

## Server-side provider contract

A production adapter must provide:
- secure recipient/account tokenization and supported-bank/rail discovery;
- account validation where supported;
- transfer creation with idempotency and provider reference;
- authenticated, replay-protected webhook/event verification;
- transfer status lookup and reconciliation reports;
- explicit return/reversal events and settlement timestamps.

Webhook processing must verify signatures against the raw request body, enforce timestamp/replay limits, deduplicate provider event IDs, lock the transfer row, reject invalid state transitions, write an immutable audit event, and update ledger/account balances in one database transaction.

## Release blockers

- Select and contract with an authorized sponsoring bank/core or licensed payment provider that supports the target country, currency, ACH and/or domestic wires, external recipient validation, and settlement webhooks.
- Obtain institution-approved credentials and configure them only as server-side secrets.
- Confirm the institution's legal authority, operational controls, KYC/AML/sanctions, fraud, limits, disclosures, dispute and return processes.
- Apply and verify the database migration, provision test accounts, and run provider sandbox tests including success, delayed, duplicate, rejected, returned, and out-of-order events.
- Complete independent security/compliance review and provider certification before enabling production execution.

## Current safety boundary

Until those dependencies are complete, AVCU may collect and review an external-transfer request and show `Approved · Awaiting Provider`. It must not represent funds as sent, pending at the receiving bank, received, or settled; it must not create a recipient-side credit or change a member's real balance.
