# Controlled Ledger Posting

Migration 202610310004_ledger_posting_controls.sql adds the first controlled journal lifecycle. It is not a payment processor and does not contact providers.

## Posting rules

- A transaction must be in draft state and contain at least two journal lines.
- Each line must contain exactly one positive debit or credit (base table constraint).
- Each entry currency must match the referenced ledger account currency.
- Debits and credits must balance independently for every currency; an FX journal must therefore contain separately balanced currency legs.
- The posting function locks the transaction header, validates all lines and marks the journal posted in one database transaction.
- Retrying a post for an already-posted journal returns the existing posted header rather than posting twice.
- Browser roles and direct service-role table writes are not granted by this migration; posting/reversal execute grants are restricted to service_role.

## Reversals

A posted journal is never edited or deleted. The reversal routine requires a reason, locks the original journal, creates a deterministic reversal idempotency key, swaps debit and credit sides, posts the compensating journal, and marks the original as reversed with a reference to the reversal. Retrying reversal returns the existing compensating journal.

## Audit and boundaries

Posting and reversal create append-only audit event rows. Journal entries can only be inserted, updated or deleted while the parent journal is draft. Posted transaction headers cannot be edited except for the controlled transition to reversed. Audit rows have no direct browser or service-role table privileges.

The service-role key must never be shipped to a browser. These functions are privileged database operations and require a server-only API that authenticates the operator, validates business authorization and writes an audit trail. The database function is not a substitute for payment authorization, account balance/available-funds checks, risk screening, provider idempotency, or reconciliation.

## Still required before production

- Migration execution and database-level tests against a disposable PostgreSQL/Supabase project.
- Dedicated application database role and narrowly scoped grants.
- Concurrency and retry tests with simultaneous posting/reversal attempts.
- Full event outbox/inbox and provider webhook signature verification.
- Statement ingestion, settlement matching and exception-case workflows.
- Independently reviewed ledger accounting policy and chart of accounts.
- Production remains disabled until legal, partner, security, operational and explicit launch gates pass.
