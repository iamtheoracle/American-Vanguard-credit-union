# American Vanguard Credit Union — Member Banking Demo

A responsive, interactive **front-end demonstration** of a fictional credit-union member experience. This repository is intentionally self-contained: HTML, CSS, and browser JavaScript only.

> **Demo-only notice:** American Vanguard Credit Union is represented here as a product concept, not a real or chartered credit union. The prototype is not insured, does not hold deposits, and cannot move real money. Jordan Hale, all account balances, transactions, rates, branch details, and the debit card are fictional sample data.

## Preview features

- Member overview with four demo shares: Share Draft, Primary Share, Money Market, and Holiday Club.
- Local share-to-share transfers and simulated bill payments from Share Draft.
- Simulated check deposits into a selected demo share.
- Debit-card freeze/unfreeze and a test purchase that declines while frozen.
- Illustrative share rates, fictional branch cards, recent activity, and a resettable demo ledger.
- Responsive desktop/mobile navigation, accessible form labels and focus states, and a visible demo disclosure.
- Local browser persistence only. No sign-in, API, bank connection, payment rail, or external font dependency.

## Run locally

No install or build step is required for the app itself. Serve the repository root with any static HTTP server, or open `index.html` directly in a modern browser.

For code checks, use Node.js 20 or newer:

```sh
npm run check
```

The check validates JavaScript syntax and runs the repository's built-in smoke tests.

## Data and privacy

The demo stores its sample ledger in this browser's `localStorage` under `avcu.member-demo.v1`. Data is not synchronized between devices. Resetting the demo restores the original sample data in this browser. Avoid entering real personal or financial information.

## Not production banking software

This preview has no authentication, backend, ledger authority, fraud monitoring, compliance controls, deposit insurance, or payment integrations. It must not be used to accept deposits, process payments, issue cards, or represent real financial products. Any future production build requires a separate, security-reviewed architecture and appropriately authorized financial-institution relationships.


## Production-readiness work in progress

The `feat/production-readiness-workflows` branch contains an initial backend/domain foundation:

- `db/schema.sql`: relational tables for members, accounts, immutable transaction history, money requests, loan applications, funding pools, notification outbox, staff roles, audit events, and migration batches.
- `src/domain/workflows.mjs`: explicit loan/request state-transition authorization and deterministic notification event keys.
- `src/domain/membership-tiers.mjs`: server-reusable tier qualification and progress calculations.
- `src/domain/migration-validation.mjs`: import validation that preserves original timestamp strings and integer minor-unit amounts, flags duplicates/invalid rows, and compares source/target reconciliation totals.
- `tests/`: unit coverage for workflow permissions, tier progress, and migration reconciliation.

These are foundations, not a deployed backend. The current static app does not call these modules, no production database or authentication provider is configured, no Gmail/OAuth sender is connected, and no payment/core-banking provider is configured. Do not use the prototype to collect real member credentials or financial information. Do not remove the demo disclosure or enable contributions/disbursements until authorized infrastructure, security review, reconciliation, and release approval are complete.

### Before enabling production integrations

1. Provision a dedicated PostgreSQL database and apply/review `db/schema.sql`.
2. Implement authenticated server endpoints using a verified identity provider and enforce role checks server-side.
3. Wire state changes and notification-outbox inserts in a single database transaction; send emails asynchronously with provider credentials held only in server environment secrets.
4. Add integration tests against a disposable database and an email sandbox, then run `npm run check`.
5. Validate migration against an authorized export, resolve every exception, and obtain independent reconciliation sign-off before cutover.
