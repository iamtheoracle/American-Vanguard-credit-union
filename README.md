# Atchison Village Credit Union (AVCU) — Standalone Operations Workspace

A responsive member-services front end built with HTML, CSS, vanilla JavaScript, and browser storage. It supports local request intake, a pending-approval queue, review decisions, and a local audit history. The current build is a workflow foundation, not a connected banking core.

## Current workflows

- Eight account categories: Share Draft (Checking), Primary Share (Savings), Holiday Club, Money Market, Business Operating Account, Traditional IRA, Share Certificate, and 401(k) Retirement.
- Internal account-transfer requests, bill-payment requests, wire requests, Zelle payment requests, FX requests, withdrawals, IRA requests, 401(k) rollover requests, check-deposit requests, and card purchase-authorization requests.
- Requests receive unique references and enter Pending Approval. Local reviewers can approve, reject, or request more information and add review notes.
- Approved internal transfers update the local account ledger only when local available funds are present.
- Approved external requests move to Approved · Awaiting Provider. They are not marked as sent or settled without provider confirmation.
- Check-deposit flow supports camera/photo capture of the front and back, previews images, and requires both images before submission. Images are kept in memory for the current browser session, not persisted to browser storage.
- The Zelle flow does not falsely claim to verify a recipient. Live directory lookup and sending require the authorized Zelle/payment provider.
- Empty local account records are used rather than fabricated opening balances, rates, card numbers, or transaction history.

## Run and test

Use Node.js 20 or newer and run: npm run check

The command validates JavaScript syntax and runs source-level regression checks. It does not replace end-to-end browser tests, security review, accessibility testing, or financial-services certification.

## Standalone-mode limits

- Browser storage is device-local and is not a secure, authoritative ledger. Requests and review records do not synchronize across devices.
- The operator workspace is not protected by real staff authentication or role-based authorization. Do not use it to approve real financial transactions.
- A local approval is a workflow decision only. It does not transmit a wire, send a Zelle payment, execute FX, credit a check deposit, control an issued card, or settle a withdrawal.
- External account balances, payment execution, check image transfer and retention, live Zelle recipient verification, FX rates and conversion, and card issuer controls require authorized providers and secure backend services.
- IRA and 401(k) workflows require provider-specific plan, eligibility, tax, identity, and compliance checks before processing.
- Do not enter real credentials, account numbers, government identifiers, or real check images into this standalone build.

## Production architecture requirements

Before real financial use, add a trusted backend, authenticated members and operators, server-enforced roles and separation of duties, immutable audit logs, idempotency and replay protection, a provider adapter layer, verified account balances, secure check-image storage, signed webhooks, reconciliation, risk controls, privacy retention policies, and institution/legal/compliance validation. Keep request state separate from settlement state; only provider-confirmed outcomes may be marked settled.