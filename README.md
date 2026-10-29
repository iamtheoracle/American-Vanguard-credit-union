# American Vanguard Credit Union — member access and onboarding

This branch replaces the former fictional banking dashboard with a member-access and verification workflow. It does not fabricate balances, transactions, card details, rates, or branch information.

## Implementation
1. Netlify Identity provides registration, email confirmation, sign-in, sign-out, and password recovery.
2. A signed-in user submits a membership application; the server stores it as pending.
3. Verification requests and their status are stored in Netlify Database (Postgres). Staff can decide approved, rejected, or resubmission.
4. The staff review API checks the Netlify Identity `admin` role on the server for every request. Decisions require notes and create an append-only review event.
5. The member view only displays the user's own application status. It does not display financial account data.

## Setup required in Netlify
- Enable and configure Netlify Identity for the site; ensure email confirmation is enabled and password recovery email templates/settings are configured.
- Enable Netlify Database for the project. The migration in `netlify/database/migrations/` is applied by Netlify on deployment.
- Assign the `admin` role only to approved staff using the Netlify Identity admin interface. Never grant admin role from the browser or signup form.
- Configure the preview deployment and run the full signup, confirmation, sign-in, recovery, member submission, staff decision, and unauthorized-access tests before merging.

Identity settings are dashboard-only. This repository cannot enable Identity or assign staff accounts in the Netlify dashboard on its own.

## Checks
Use Node.js 20 or newer:
```sh
npm install
npm run check
```

The tests check source-level security invariants and absence of the previous fabricated financial content. They are not a substitute for end-to-end tests against a configured Netlify preview.

## Explicit limits
No banking/core system is connected. No balances, ledger entries, transfers, deposits, card actions, interest rates, or financial products are shown or processed. No identity documents are collected by this workflow; connect an approved identity-verification provider and define secure document handling before adding document uploads. Membership approval in this workflow is not a substitute for a real financial institution's legal, compliance, or core-banking controls.

Do not release to production until Netlify Identity and Database are configured, the preview deployment is green, and the authenticated and unauthenticated flows have been exercised end-to-end.
## External house-wire confirmation queue (not enabled)

A separate design contract for the proposed staff-only Goldenwest receiving-bank confirmation queue is in [docs/staff-wire-confirmation-queue.md](docs/staff-wire-confirmation-queue.md). It defines dedicated submitter/approver roles, two-person review, append-only evidence events, and the boundary between manual evidence review and a bank-confirmed recipient credit. **This is a design specification, not an implemented or deployed queue.** No wire provider, Goldenwest integration, or authoritative banking ledger is connected. Wire initiation and recipient credit remain disabled; the Kate-to-Judith scenario is illustrative only.
