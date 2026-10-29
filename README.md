# Atchison Village Credit Union (AVCU) — Standalone Operations Workspace

A responsive member-services front end built with HTML, CSS, vanilla JavaScript, Netlify Identity, Netlify Functions, and Netlify Database. Unauthenticated use remains device-local. Authenticated requests use the server-backed workflow API only when Identity and the database are enabled; this is still not a connected banking core.

## Current workflows

- Eight account categories: Share Draft (Checking), Primary Share (Savings), Holiday Club, Money Market, Business Operating Account, Traditional IRA, Share Certificate, and 401(k) Retirement.
- Internal account-transfer requests, bill-payment requests, wire requests, Zelle payment requests, FX requests, withdrawals, IRA requests, 401(k) rollover requests, check-deposit requests, and card purchase-authorization requests.
- Requests receive unique references and enter Pending Approval. Local reviewers can approve, reject, or request more information and add review notes.
- In local mode, internal transfers are blocked unless local available funds exist. In the authenticated API, transfers require two server-recorded account balances, sufficient funds, and a transactional ledger write.
- Approved external requests move to Approved · Awaiting Provider. They are not marked as sent or settled without provider confirmation.
- Check-deposit flow supports camera/photo capture of the front and back, previews images, and requires both images before submission. Images are kept in memory for the current browser session, not persisted to browser storage.
- The Zelle flow does not falsely claim to verify a recipient. Live directory lookup and sending require the authorized Zelle/payment provider.
- Local automated review flags identify high-value requests, retirement/check requirements, and possible duplicates. They are advisory rules, not an AI fraud verdict.
- A review-assistant adapter can be connected to a trusted backend later; AI output must remain advisory and cannot replace operator approval.
- Account balances display as Not connected until a trusted account-core provider supplies them. Empty account records are used rather than fabricated opening balances, rates, card numbers, or transaction history.

## Run and test

Use Node.js 20 or newer.

- Build the Identity browser client: `npm install && npm run build:auth`
- Source and backend validation: `npm run check`
- Desktop and mobile browser audit: `cd tests/browser && npm install && npx playwright install chromium && npx playwright test`

The Playwright suite runs in Chromium at desktop and mobile viewports. It checks navigation, request submission, operator request-information and rejection decisions, zero-balance transfer blocking, external-payment provider boundaries, Zelle verification safeguards, check-image previews/requirements, card freeze labeling, and horizontal overflow. GitHub Actions runs both the source checks and browser suite.

Browser automation is not a substitute for real-device/manual accessibility testing, an independent security review, institution compliance validation, or live provider certification.

## Shared-workspace setup and remaining limits

- Netlify Identity must be enabled on the exact Netlify site serving this branch. Keep enrollment invite-only for institutional use. The Identity event assigns new accounts the member role; an authorized administrator must assign operator/admin roles. Never grant staff roles from the browser.
- Netlify Database is available only on eligible credit-based Netlify plans. The committed migration creates shared request, audit, account-balance, and ledger tables without seeding balances. Deploy previews apply migrations to their own database branch; verify the preview database before enabling production.
- Authenticated requests use the /api/workflow function. It checks Identity roles server-side, requires idempotency keys, prevents operators reviewing their own requests, records audit events, and uses a database transaction for internal transfers. API responses omit internal user IDs and idempotency keys.
- If Identity or the database is unavailable after sign-in, the UI shows the shared-service error and does not silently fall back to local approvals. Unauthenticated local mode remains device-local and is not secure for real staff review.
- Account balances display as Not connected until a trusted account-core provider supplies verified balances. The API cannot seed balances: transfers require existing server-side account records and sufficient funds.
- Wire, bill-payment, withdrawal, IRA/401(k), and card-authorization approvals remain Approved · Awaiting Provider. No provider is configured to send funds or authorize a merchant. Zelle approval is blocked without server-verified recipient data. FX requests are blocked without a live server-side quote. Check deposits are blocked in authenticated shared mode until secure image storage and review are implemented.
- Do not enter real credentials, account numbers, government identifiers, or real check images until the institution has completed security, privacy, regulatory, provider, and compliance reviews.

## Production readiness

The backend foundation is now in the branch, but the shared queue is not production-ready until the target Netlify site has Identity enabled, the database migration has applied successfully, operator roles have been assigned, and authenticated API flows have been tested against the deployed preview. Real payment execution, secure check-image retention, live Zelle verification, FX conversion, core-account balance feeds, issuer card controls, signed provider webhooks, and reconciliation still require authorized providers and institution configuration. Only provider-confirmed outcomes may be marked settled.



