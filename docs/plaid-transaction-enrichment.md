# Plaid merchant enrichment for AVCU transaction history

## What is implemented

The member transaction-history renderer now recognizes optional Plaid merchant-enrichment fields on a posted ledger row (either at the row root or under `merchant`):

- `merchant_name`
- `logo_url`
- `personal_finance_category.detailed` and `personal_finance_category.primary`
- `payment_channel`
- `location.address`, `city`, `region`, and `postal_code`

The renderer escapes text and attributes, accepts merchant logos only from Plaid's merchant-logo host over HTTPS, and omits the enrichment row when no useful merchant data exists. Amount, direction, account, timestamp, and request reference continue to come from the posted ledger record; enrichment never changes financial values.

## Walmart example

A Plaid merchant object with `merchant_name: "Walmart"`, the supplied Plaid logo, `GENERAL_MERCHANDISE_SUPERSTORES`, `payment_channel: "in store"`, and the Poway, California location will display as Walmart with a category, channel, and location beneath the posted transaction.

The merchant object alone is not a transaction. It must be joined to a real transaction using Plaid's transaction identifier before being displayed.

## Data contract for the transaction API

When the authorized transaction-sync integration is added, it should attach a sanitized `merchant` object to the corresponding posted ledger row. Keep the original transaction identifier and provider reference server-side. Only return the display fields listed above to the authenticated owner of the transaction.

Example response shape (illustrative contract only):

```json
{
  "request_id": "ledger-request-reference",
  "direction": "debit",
  "amount_cents": 4287,
  "created_at": "2026-10-30T12:00:00Z",
  "account_type": "draft",
  "request_type": "card-authorization",
  "purpose": "Card purchase",
  "merchant": {
    "merchant_name": "Walmart",
    "logo_url": "https://plaid-merchant-logos.plaid.com/walmart_1100.png",
    "website": "walmart.com",
    "payment_channel": "in store",
    "personal_finance_category": {
      "primary": "GENERAL_MERCHANDISE",
      "detailed": "GENERAL_MERCHANDISE_SUPERSTORES"
    },
    "location": {
      "address": "13425 Community Rd",
      "city": "Poway",
      "region": "CA",
      "country": "US",
      "postal_code": "92064"
    }
  }
}
```

## Not yet connected

This UI change does not yet call Plaid Transactions Sync, persist Plaid transaction records, or join Plaid transactions to the authoritative banking-core ledger. The current `/api/plaid` integration connects bank accounts through Auth and stores encrypted access tokens; it does not fetch transaction history. Do not present the supplied Walmart merchant object as a real AVCU purchase without a matching transaction record.

Before enabling live transaction sync, add a database migration for transaction IDs and sync cursors, implement server-side `/transactions/sync` with cursor pagination and removal handling, encrypt/secure provider tokens, enforce member ownership, deduplicate transactions, and reconcile imported records against the institution's authoritative account activity. Plaid enrichment must never create a balance, debit, credit, or settled-payment claim.
