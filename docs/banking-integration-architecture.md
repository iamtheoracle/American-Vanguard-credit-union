# AVCU Banking Foundation

**Status:** design and schema foundation only. No provider is contracted or connected. No production banking is enabled.

## Product scope

AVCU is designed for both individual and business customers, with its own partner-sponsored accounts and separate external-bank connectivity. International availability is jurisdiction- and provider-specific; it is not a promise of global coverage.

## Provider roles

| Capability | Candidate | Important limitation |
|---|---|---|
| International accounts, settlement, FX | Banking Circle | Eligibility and authorisation requirements apply; not a direct-to-consumer bank |
| UK/EEA account and payment infrastructure | ClearBank | Incorporation, regulatory and commercial eligibility apply |
| US embedded banking | Unit | US partner-bank programme; not global |
| External account connectivity | Plaid | Only supported countries/institutions/products |
| Card issuing and processing | Marqeta | Market/programme approval required |
| Local domestic banking | Locally authorised bank per country | Select separately in every launch jurisdiction |

No candidate is selected as a contracted production provider. Provider choice requires written eligibility confirmation, due diligence, commercial agreement, sandbox access and certification.

## Architecture boundaries

1. **Identity:** authentication and member identity are not financial authorisation.
2. **Account registry:** stores references and status returned by approved banking partners. It does not create real accounts.
3. **Ledger:** immutable double-entry accounting records, balanced separately by currency.
4. **Payment orchestration:** validates member authority, account status, limits, risk controls and available funds before submitting instructions.
5. **Provider adapters:** translate AVCU's canonical commands and events to provider-specific APIs.
6. **Webhook inbox:** verify provider signatures, persist event IDs, deduplicate, and process asynchronously with retry and quarantine.
7. **Reconciliation:** match provider statements and settlement reports against ledger postings; unresolved differences create cases, not silent adjustments.
8. **Cards:** store provider token/reference and lifecycle metadata only; never store CVV or full PAN in AVCU.
9. **External banks:** use customer-authorised consent flows and keep external account data separate from AVCU-issued accounts.

## Canonical transaction lifecycle

`created -> risk_checked -> approved -> submitted -> pending -> posted`

Alternative terminal/exception states: `failed`, `cancelled`, `reversed`, `requires_review`.

- Every command carries a unique idempotency key.
- A timeout is an unknown outcome, not proof of failure. Query provider status before retrying.
- A provider webhook is evidence to verify and reconcile, not permission to blindly mutate a balance.
- Reversals create compensating journal entries; posted history is never deleted.
- Debits and credits must balance per currency before posting.
- FX uses separate currency legs and an explicit rate, fee and execution reference.

## Database foundation

Migration `202610310002_banking_foundation.sql` creates:
- `avcu_financial_accounts`: provider-independent account references.
- `avcu_ledger_accounts`: chart-of-accounts primitives.
- `avcu_ledger_transactions`: idempotent journal headers.
- `avcu_ledger_entries`: debit/credit lines.
- `avcu_provider_events`: deduplicated webhook inbox.

All tables have RLS enabled and direct `anon` / `authenticated` access revoked. This is intentional: no browser client can create accounts, write ledger entries, or process provider events.

**Not yet implemented:** reviewed server-side posting functions, deferred per-currency balance enforcement, account ownership policies, payment APIs, provider adapters, webhook signature verification, reconciliation jobs, KYC/KYB, or any production credentials. Do not treat this schema alone as a usable ledger.

## Release gates

- Legal entity and initial operating jurisdiction confirmed.
- Regulated partner and product scope approved in writing.
- Applicable permissions/licensing and safeguarding arrangements reviewed.
- KYC/KYB, AML/CTF, sanctions and transaction monitoring approved.
- Server-side posting and reconciliation tested, including concurrency and failure recovery.
- Provider sandbox certification and security assessment complete.
- Customer agreements, complaints, disputes and operational support ready.
- Explicit authorised production launch approval recorded.

Until all gates pass, provider credentials remain absent and production money movement stays disabled.
