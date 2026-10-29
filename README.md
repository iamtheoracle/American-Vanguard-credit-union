# Atchison Village Credit Union (AVCU) — Local Banking Demo

A responsive, interactive front-end prototype for a fictional credit-union member experience. It uses HTML, CSS, vanilla JavaScript, and browser `localStorage`; there is no backend.

> **Local demo only.** Atchison Village Credit Union is a fictional product concept in this prototype, not a real or chartered financial institution. This demo is not NCUA-insured, does not hold deposits, and cannot move real money. Jordan Hale, balances, transactions, card details, sample rates, and community-area references are fictional sample data.

## Included demo journeys

- Seven sample accounts: Share Draft (Checking), Primary Share (Savings), Holiday Club, Money Market, Business Operating Account, Traditional IRA, and Share Certificate.
- Local share-to-share transfers with paired debit/credit ledger entries.
- Simulated bill payments from Share Draft.
- Simulated check deposits into a selected sample account.
- Debit-card freeze/unfreeze and simulated purchase authorizations. Approved sample purchases debit Share Draft and add a ledger entry; frozen, invalid, or insufficient-funds purchases are declined without changing balances.
- Illustrative share rates, Richmond and San Pablo community-area references, recent activity, and a resettable demo ledger.
- Responsive desktop/mobile navigation, keyboard focus styling, reduced-motion support, accessible labels, and live status announcements.
- Local browser persistence only. No sign-in, API, bank connection, payment rail, or external font dependency.

## Run locally

No install or build step is required to run the app. Serve the repository root with any static HTTP server, or open `index.html` directly in a modern browser.

For code checks, use Node.js 20 or newer:

```sh
npm run check
```

This command checks JavaScript syntax and runs the built-in Node test suite. These are source-level smoke/regression checks, **not** a substitute for real browser testing across devices and assistive technologies.

## Demo account behavior

All seven account types are intentionally available in the local simulation so users can explore the UI. Traditional IRA and Share Certificate are illustrative account categories only; the prototype does not enforce actual tax, eligibility, maturity, withdrawal, contribution, or early-withdrawal rules. Do not use this model to infer real account terms.

The debit-card simulator uses Share Draft (Checking) as its funding source. An approved test purchase reduces that demo balance and creates a matching sample-ledger debit. A frozen card, invalid purchase, or purchase exceeding the available demo checking balance is declined without a balance change.

## Data and privacy

The demo stores its sample ledger in this browser's `localStorage` under `avcu.member-demo.v1`. Data is not synchronized between devices. Resetting the demo restores the original sample data in this browser. Avoid entering real personal or financial information. Browser storage is not a secure banking data store.

## Not production banking software

This preview has no authentication, backend, authoritative ledger, fraud monitoring, compliance controls, deposit insurance, or payment integrations. It must not be used to accept deposits, process payments, issue cards, or represent real financial products. Any future production build requires a separate, security-reviewed architecture and appropriately authorized financial-institution relationships.
