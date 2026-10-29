# American Vantoris Credit Union (AVCU) — Banking Prototype

AVCU is a software prototype with a responsive browser demo and a separate Express/PostgreSQL API. It is **not a real or chartered credit union**.

> **Demo-only financial notice:** No deposits are held, no real money moves, and no deposit insurance or banking license is represented. Demo balances, members, cards, rates, and transactions are fictional. Do not enter real financial or identity information.

## What is in this repository

- Responsive member-facing demo interface with simulated shares, transfers, bill payments, deposits, card freeze/unfreeze, activity, and a clear demo disclosure.
- Separate authenticated API-connected member portal at `/member-portal.html` for registration, sign-in, accounts, transactions, transfers, deposits, sandbox card controls, membership tier, and notifications.
- Separate role-checked operator console at `/operator-portal.html` with a centralized approval queue, server-side status/type/search filters, pagination, a decision workspace with mandatory notes, audited member history (accounts, transactions, loan applications, money requests, and decisions), membership tiers and audited overrides, migration staging, audit history, loan alerts, and email delivery history.
- Express API for member registration/login, unique 10-digit numeric member IDs (separate from email), sessions, account and transaction endpoints, operator workflows, server-enforced roles, approval separation of duties, ledger entries, audit events, idempotency, and sandbox integrations.
- PostgreSQL migrations and seed data for API development.
- Activity-based membership tiers: New Member, Active Member, Established Member, Priority Service, and Review Required; tier changes are recorded in history and manual overrides are audited.
- Gmail API notification adapter for membership and transaction status events, with delivery history and a persistent PostgreSQL outbox, bounded retries, and event-key deduplication. Gmail delivery is skipped until OAuth environment variables are configured.
- Automated syntax, demo smoke, and PostgreSQL-backed API tests in GitHub Actions.

**Important integration boundary:** The original demo at `/` still uses local browser storage and simulated data. The API-connected member and operator portals are separate pages that use the authenticated API. This remains a development prototype, not a production-ready banking system.

## Requirements and local setup

- Node.js 22+
- PostgreSQL 16+ (or a compatible PostgreSQL release)

The development seed includes public demo credentials and is explicitly blocked when `NODE_ENV=production`. Production must set `DATABASE_URL` explicitly; the local fallback is for development only. The notification worker persists email events before attempting delivery. Delivery is at-least-once: a process crash after a provider accepts an email but before the outbox is marked sent can still result in a duplicate email, so the application deduplicates queued business events but does not claim exactly-once provider delivery.\n\nInstall and configure the database:

```sh
npm ci
export DATABASE_URL="postgres://avcu:avcu@127.0.0.1:5432/avcu"
npm run migrate
npm run seed
npm run check
npm test
npm run test:api
npm start
```

The API and static demo are served from the same process. The default database URL is for local development only; use your own local database credentials. Seeded demo credentials are development-only and must never be reused in production.

## Gmail notifications

The server sends email using the Gmail API with OAuth refresh-token authorization. It does **not** use or store a Gmail account password. Configure these values as deployment secrets/environment variables:

- `AVCU_GMAIL_CLIENT_ID`
- `AVCU_GMAIL_CLIENT_SECRET`
- `AVCU_GMAIL_REFRESH_TOKEN`
- `AVCU_GMAIL_FROM` — for this project, `esslerlazaroski@gmail.com`, provided that this address belongs to the Google account authorized by the refresh token or is a verified Gmail sending alias.

Create OAuth credentials in Google Cloud, enable the Gmail API, authorize the account through Google's consent flow, and grant only the Gmail send scope needed by the app. Never commit OAuth secrets, refresh tokens, passwords, or verification codes. If configuration is absent, delivery is recorded as `skipped`; provider errors are recorded as `failed`, not falsely marked as sent.

Operator endpoints (authenticated and role-checked):

- `GET /api/operator/membership-tiers` — list and filter tier assignments.
- `PUT /api/operator/members/:id/tier` — audited manual tier override; requires a reason.
- `DELETE /api/operator/members/:id/tier/override` — clear override and recalculate.
- `GET /api/operator/members/:id/tier/history` — tier history.
- `GET /api/operator/email-deliveries` — delivery status history.

Member endpoint: `GET /api/membership-tier`.

## Testing

`npm run check` validates the JavaScript syntax for the frontend and API.
`npm test` runs the browser-demo smoke tests and pure membership-tier policy tests.
`npm run test:api` runs API integration tests against PostgreSQL and creates temporary test databases; the configured test database user must have permission to create and drop databases.

## Security and production boundary

Members receive a unique 10-digit numeric member ID at registration. They can sign in with that ID or their email address; neither is a substitute for the password. Google sign-in is not configured in this prototype.

The API uses password hashing, expiring server-side sessions, role checks, audit events, approval workflows, integer cents, and a PostgreSQL ledger. These controls are useful development foundations, not a production security certification. Before any real use, the system still needs an independent security review, threat modeling, end-to-end frontend/API integration, operational monitoring, backups, privacy/legal review, fraud/AML controls as applicable, authorized banking/payment partners, and required licenses and regulatory approvals. No production deployment is included by this implementation branch.

## Loan applications and funding-pool boundaries

The member API now supports `POST /api/loans/applications`, `GET /api/loans/applications`, and a member response endpoint for requested information. Loan applications create a management approval record, an operations alert, a member notification, an audit event, and—when `AVCU_OPERATIONS_EMAIL` is configured—a durable operations email outbox event in the same database transaction. Operators can list and acknowledge alerts at `/api/operator/loan-alerts`; final decisions remain role-checked. An approved application is **not** a disbursement and creates no loan balance or movement of funds.

The member portal reads published funding pools from `GET /api/funding-pools`. Funding progress is calculated only from contribution rows whose status is `verified`. Pools are not seeded or published by default, return assumptions and terms remain blank until approved configuration is supplied, and `POST /api/funding-pools/:id/contributions` deliberately returns a disabled response. No live contribution, custody, settlement, or investment functionality is enabled.

Configure `AVCU_OPERATIONS_EMAIL` with an authorized operations mailbox and `AVCU_PUBLIC_BASE_URL` with the deployment's HTTPS origin to make the loan alert email actionable. If no operations email is configured, the database-backed operations alert still exists and remains visible in the operator console, but email delivery is not claimed.

## Legacy migration staging

Authorized staff can stage a JSON array of legacy transaction rows from the operator console or `POST /api/operator/migrations/validate`. Validation preserves original timestamp text and signed minor-unit amounts, records every raw row, identifies duplicate source references and invalid fields, stores exception reports, and groups totals by source account/currency/status. Each batch stores a SHA-256 fingerprint of the canonical parsed JSON payload; this is **not** a raw source-file byte hash because no source file upload/parser has been configured yet.

Batches with validation exceptions are marked `blocked`; even clean batches are staging-only. No import, balance posting, account cutover, or production migration is exposed until an authorized source export, approved account mapping, target-side reconciliation, and separate release approval exist. Viewing migration exceptions and audit history is role-restricted and logged.

## Money requests

Members can submit and track withdrawal, transfer, account-service, and other money requests through the authenticated API and member portal. Staff can request more information, and management makes final approval/rejection decisions with a recorded reason. Requests, decisions, audit events, member notifications, and the operations email outbox are persisted transactionally. Approval only changes the request status; it does not create a transaction or move funds.

## Member identity

New membership applications require a unique lowercase username (3–24 letters, digits, or underscores), a legal name, email, and password. The system keeps that username separate from the generated 10-digit numeric member number and account identifiers. Member sign-in accepts username, email, or numeric member number; credentials remain server-side and are never included in ordinary member records. Existing accounts without a username can continue using their email or member number until an authorized profile-update flow is provided.

## Password recovery

The authenticated API supports a generic password-reset request response to reduce account enumeration, rate-limited requests, a 30-minute random reset token stored only as a SHA-256 hash, single-use completion, and revocation of existing member sessions after a password change. Reset emails are queued through the durable outbox. A valid `AVCU_PUBLIC_BASE_URL` and configured Gmail OAuth are required for a member to receive a usable reset link; without them, the API does not create a reset token and the generic response remains unchanged.
