# AVCU — America Vanguard

AVCU is a digital financial-services platform in development. This repository contains application software and infrastructure work; it does not establish that AVCU is a chartered credit union, bank, deposit custodian, card issuer, money transmitter, or insured financial institution.

## Institutional and production status

**No real deposits are accepted and no real-money payment, ACH, wire, card, lending, or stablecoin service is enabled by this repository.** Production launch requires a legally valid charter or authorized sponsor-bank/custody arrangement, executed provider agreements, regulatory and compliance approvals, production credentials, security review, operational controls, disclosures, reconciliation, and successful end-to-end certification.

Never represent development records, local storage, seeded accounts, sandbox cards, test webhooks, or simulated transactions as customer funds or live services. Production must not seed sample members, balances, transactions, cards, branch addresses, or rates.

## Application architecture

- Express API and PostgreSQL-backed authenticated member and operator portals.
- Server-enforced authorization, session management, approval separation of duties, audit events, idempotency and existing ledger controls.
- Additive asset-aware double-entry ledger foundation is under review in PR #16; it is not yet the production ledger and is not wired to live payment providers.
- Personal and business account ownership, permissions, holds, payment intents, provider event inbox and outbox structures are being developed.
- Fiat and stablecoin custody are separate domains. ACH and wires require authorized bank-held fiat accounts; stablecoin transfers require a separately approved digital-asset provider and custody arrangement.

## Development

Use Node.js 22 or later, install locked dependencies with `npm ci`, configure a disposable PostgreSQL database using `DATABASE_URL`, and run `npm run migrate`. Development seed data is for isolated testing only and must never be used in production. Do not put real member identity, bank, card, or payment information into development environments.

## Release gates

A release must remain disabled for production money movement until institution/provider approvals, KYC/KYB/AML and sanctions controls, member-bound authorization, step-up authentication, transaction limits, fraud controls, provider webhook signature verification, replay protection, reconciliation, incident response, privacy/security review, and required disclosures are complete and independently tested.

The public root page intentionally contains no fabricated account balances, members, transactions, card numbers, rates, or branch locations. The member portal only exposes records returned by its authenticated API.
