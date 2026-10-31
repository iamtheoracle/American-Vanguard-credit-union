# AVCU Supabase authentication foundation

## Current state

The existing AVCU site is a local-only fictional demonstration. It has no login backend,
member authentication database, or email delivery provider. The current sample member,
balances, transactions, rates, and card must not be imported as real member data.

This branch adds the database boundary for a future Supabase Auth integration. It does
not connect or deploy a Supabase project, create users, change passwords, or send email.

## Identity and financial-data separation

- Supabase Auth owns credentials, email verification, sessions, and password recovery.
- `public.member_profiles` maps an authenticated Supabase user to an AVCU member number.
- This table is not a ledger and must never be used to calculate balances or authorize payments.
- Financial records remain in an authoritative ledger/service with independent authorization,
  posting, settlement, and audit controls.
- Client users can read only their own profile. There are intentionally no client write policies.
- Member provisioning, lock/unlock, and member-number assignment must happen through a
  trusted server process with an audit trail.

## Required project configuration (not yet available)

1. Create/select the AVCU Supabase project in the organization's account.
2. Configure the production site URL and exact allowed redirect URLs.
3. Disable public signups. Provision only verified, approved members through an authorized
   onboarding process.
4. Require email confirmation and configure password policy and MFA policy.
5. Configure custom SMTP with a verified AVCU sender domain. Supabase's built-in sender
   is restricted and best-effort; it is not production delivery.
6. Store the Supabase project URL and publishable/anon key as deployment configuration.
   Never put a service-role key in browser code or source control.
7. Configure recovery links to a dedicated password-update route. Use PKCE, single-use
   recovery links, short expiry, and session revocation after credential changes.
8. Configure rate limits and security notifications; monitor auth audit events.
9. Validate with dedicated staging accounts before enabling member access.

## Recovery and account-enumeration protection

Use Supabase Auth's password recovery endpoint and return the same user-facing response
whether or not an email is registered. Do not query the Auth admin API from the browser.
Do not disclose account existence, verification state, lock state, or member details
through public endpoints.

## Outstanding inputs

- Supabase project access / project URL and publishable key (the key can be configured
  as a public deployment variable; never share a service-role secret in chat).
- Verified sender domain and SMTP provider configuration.
- Authorized staging member accounts and an approved member-provisioning source.
- Confirmation of the production domain and allowed redirect URLs.

## Safe release rule

Do not publish a production login route or replace the demo entry point until the Supabase
project is configured, SMTP is verified, staging auth tests pass, and the member provisioning
and account-status enforcement path has been reviewed.
