# AVCU Plaid integration

## Implemented foundation
- Authenticated Netlify Function at `/api/plaid` creates Plaid Link tokens for US checking/savings accounts using the Auth product.
- Public tokens are exchanged server-side; the access token is encrypted with AES-256-GCM before being stored.
- Connected institution and masked account metadata are stored per authenticated AVCU member.
- A member-facing Connect an external bank panel launches Plaid Link and lists connected accounts.
- No raw credentials, public tokens, or access tokens are returned to the browser or written to logs.
- This is bank-account linking / Auth only. It does not initiate ACH, wires, debit balances, or create AVCU deposit accounts.

## Netlify environment variables
Set these in the Netlify site's server-side environment:
- `PLAID_CLIENT_ID`: Plaid Dashboard client ID.
- `PLAID_SECRET`: newly rotated Plaid secret (never reuse the secret previously pasted into chat).
- `PLAID_ENV`: `sandbox` initially; `production` only after Plaid approves the app.
- `PLAID_TOKEN_ENCRYPTION_KEY`: base64 encoding of a cryptographically random 32-byte key. Generate with `openssl rand -base64 32`. Store it as a secret and back it up securely; losing it makes stored access tokens unreadable.

## Database
Apply `netlify/database/migrations/202610300001_create_avcu_plaid_items.sql` to the same Netlify database used by the workflow function. Do not enable the integration until the migration succeeds.

## Plaid Dashboard
1. Create/configure the AVCU app in Plaid Dashboard.
2. Enable Auth for Sandbox.
3. Register the exact deployed redirect URI if the selected institutions require OAuth.
4. Use Plaid Sandbox test institutions to validate Link and account metadata.
5. Request Production access and complete Plaid's review before switching `PLAID_ENV=production`.

## Important boundaries
- The Link flow uses `products: ["auth"]` and limits selection to checking/savings. Do not request Liabilities unless the feature actually needs loan/credit liability data; this avoids the unrelated `NO_LIABILITY_ACCOUNTS` failure mode.
- Plaid Auth verifies account/routing information for supported accounts. This app currently stores only masked account metadata; no account/routing numbers are returned to the browser.
- Plaid Transfer, ACH debit/credit, and domestic wire are separate products/permissions. No money movement endpoint is implemented or enabled here.
- The current wire request flow remains `approved-awaiting-provider`; it is not a submitted wire.
- The app's existing local account balances are not replaced with Plaid linked-bank balances. A linked external account is not an AVCU account or proof of funds held by AVCU.
