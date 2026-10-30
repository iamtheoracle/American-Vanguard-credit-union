# Plaid integration — AVCU member bank connections

## What is implemented on this branch

- Auth-only Plaid Link token creation for US checking and savings accounts.
- Server-side public-token exchange.
- Encrypted access-token storage using AES-256-GCM and a 32-byte key.
- Account metadata retrieval through `/accounts/get`, including Plaid's account verification status.
- Member-scoped connected-item retrieval.
- Same-Day Micro-deposit verification Link-token creation using the existing access token. The verification Link token intentionally omits `products`, as required by Plaid.
- Member-triggered status refresh through `/accounts/get`.
- Member UI states for pending, verified, failed, and expired verification.

## Deployment configuration

Set these as Netlify environment variables. Never commit values to Git or put them in browser code.

- `PLAID_CLIENT_ID`: Plaid application client ID.
- `PLAID_SECRET`: secret for the selected Plaid environment.
- `PLAID_ENV`: `sandbox` or `production`; defaults to sandbox.
- `PLAID_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte random key used for AES-256-GCM encryption of stored access tokens.
- `PLAID_WEBHOOK_URL`: optional HTTPS webhook URL. Do not configure until a verified webhook receiver is deployed.

Generate an encryption key with a secure secret manager or a cryptographically secure local command such as `openssl rand -base64 32`. Back up the key securely: losing it makes stored access tokens unrecoverable. Rotate it only with a planned re-encryption migration.

## Important production controls

1. Rotate any Plaid secret that has been pasted into chat, source code, logs, or tickets. Treat it as compromised.
2. Start with Sandbox and confirm Link, token exchange, account retrieval, and manual verification against Plaid's documented test cases.
3. Plaid Production credentials and product access must be approved in the Plaid Dashboard. Setting `PLAID_ENV=production` does not grant production approval.
4. Do not set production credentials until AVCU's legal entity, actual operating model, geography, sponsor-bank relationship where required, and intended Plaid products have been approved by Plaid.
5. The current Link integration requests Auth only. It does not request Transactions, Identity, Liabilities, or Transfer.
6. A verified Auth account is not a funded AVCU deposit account and is not proof of available funds. It does not authorize ACH or domestic wire payments.
7. Do not put account/routing numbers or access tokens in browser storage, application logs, analytics, request descriptions, or audit notes.
8. Keep all external payments disabled until the authorized provider and institution approve the exact payment rail and the core ledger, limits, fraud/sanctions controls, reconciliation, and returns process are live.

## Same-Day Micro-deposit lifecycle

1. Customer connects an eligible US account through Auth Link.
2. Server exchanges the public token and retrieves `/accounts/get` status.
3. For `pending_manual_verification`, AVCU offers a Verify account action.
4. Server creates a verification Link token from the member-owned Item's decrypted access token. The request does not include `products`.
5. Customer completes the code verification in Plaid Link.
6. AVCU re-queries `/accounts/get` and displays the status returned by Plaid. The client never writes `manually_verified` itself.

Plaid's current Auth documentation describes the verification states and Same-Day Micro-deposit sequence:
- https://plaid.com/docs/auth/coverage/same-day/
- https://plaid.com/docs/api/products/auth/

## Not yet implemented

- Plaid Transactions product, `/transactions/sync`, merchant enrichment, transaction webhooks, and cursor persistence.
- Plaid Auth webhook signature/JWT verification and asynchronous verification-state updates.
- Retrieval and controlled use of Auth numbers after verification.
- Plaid Transfer setup, transfer authorization, wire recipient migration, or any real payment execution.
- A sponsor-bank/core ledger integration and authoritative balance/settlement reconciliation.

These are separate work items and require their own product enablement, schema, tests, and security review. Do not infer that this Auth integration enables Transfer or domestic wires.
