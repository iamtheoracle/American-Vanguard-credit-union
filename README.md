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

- Netlify Identity must be enabled on the exact Netlify site serving this branch. Keep enrollment invite-only for institutional use. The Identity event assigns new accounts the member role by default. Configure the server-side Netlify environment variables AVCU_OPERATOR_EMAILS and AVCU_ADMIN_EMAILS with comma-separated, institution-approved email addresses to assign staff roles at signup. Never grant staff roles from the browser. Existing users require a trusted admin role update; role changes take effect on the user's next login or token refresh.
- Netlify Database is available only on eligible credit-based Netlify plans. The committed migration defines shared request, audit, account-balance, and ledger tables without seeding balances. The latest preview deployment reported that no database migrations were applied, so database provisioning and schema creation are not yet verified. Do not treat the shared queue as active until the migration is confirmed in the target site's database.
- Authenticated requests use the /api/workflow function. It checks Identity roles server-side, requires idempotency keys, prevents operators reviewing their own requests, records audit events, and uses a database transaction for internal transfers. API responses omit internal user IDs and idempotency keys.
- If Identity or the database is unavailable after sign-in, the UI shows the shared-service error and does not silently fall back to local approvals. Unauthenticated local mode remains device-local and is not secure for real staff review.
- Account balances display as Not connected until a trusted account-core provider supplies verified balances. The API cannot seed balances: transfers require existing server-side account records and sufficient funds.
- Wire, bill-payment, withdrawal, IRA/401(k), and card-authorization approvals remain Approved · Awaiting Provider. No provider is configured to send funds or authorize a merchant. Zelle approval is blocked without server-verified recipient data. FX requests are blocked without a live server-side quote. Check deposits are blocked in authenticated shared mode until secure image storage and review are implemented.
- Only enter sign-in credentials after confirming this is the institution-authorized deployment. Do not enter real account numbers, government identifiers, or check images until the institution has completed security, privacy, regulatory, provider, and compliance reviews.

## Member transaction history

- The member Transaction History view reads the signed-in member's own workflow requests and posted account-ledger entries for the trailing 365 days.
- Monthly posted credits and debits are calculated from `avcu_account_ledger`; in the current workflow those entries represent internal account transfers, not payroll or outside income. Request submissions are not treated as posted cash movement.
- Monthly wire requests, gift-described wire requests (purpose text containing “gift”), and bill-payment requests are shown in a separate table and are explicitly labeled as request amounts, not deposits or completed payments.
- Pending wires and bills remain separate from posted totals. A wire is not represented as received or settled unless an authorized provider confirms settlement and a trusted ledger records the posting.
- The Copy statement action copies the displayed member history, including timestamps, references, posted totals, monthly request amounts, and request statuses.
- The endpoint filters requests and ledger rows by the authenticated Identity user and limits the reporting window to 365 days. No browser-local sample activity is substituted when the shared service is unavailable.

## Production readiness

The backend foundation is now in the branch, but the shared queue is not production-ready until the target Netlify site has Identity enabled, the database migration has applied successfully, operator roles have been assigned, and authenticated API flows have been tested against the deployed preview. Real payment execution, secure check-image retention, live Zelle verification, FX conversion, core-account balance feeds, issuer card controls, signed provider webhooks, and reconciliation still require authorized providers and institution configuration. Only provider-confirmed outcomes may be marked settled.



