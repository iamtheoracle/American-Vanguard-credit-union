# American Vantoris Credit Union — Member Banking Demo

A responsive, interactive **front-end demonstration** of a fictional credit-union member experience. This repository is intentionally self-contained: HTML, CSS, and browser JavaScript only.

> **Demo-only notice:** American Vantoris Credit Union is represented here as a product concept, not a real or chartered credit union. The prototype is not insured, does not hold deposits, and cannot move real money. Jordan Hale, all account balances, transactions, rates, branch details, and the debit card are fictional sample data.

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
