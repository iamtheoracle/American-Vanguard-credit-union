# RCC history implementation and AVCU repository audit

## Discovery findings (verified from repository contents)

- The repository default branch is `main`; it is a static HTML/CSS/browser-JavaScript demo using localStorage and hardcoded illustrative account balances and transactions. Its README explicitly says the product is fictional and cannot move real money.
- The separate `full-stack-avcu` branch contains an Express API, PostgreSQL access, migrations, member/operator routes, ledger code, and tests. It is not the default branch. Its `package.json` check script references `operator.js`, `login.js`, and `chat.js`; the visible tree did not show these at the root, so this needs verification/fixing before relying on that branch's checks.
- `netlify.toml` in the static implementation sets `connect-src 'none'`, which prevents browser API calls from that origin. Static Netlify publishing by itself does not run the Express/PostgreSQL backend.
- Open PR #4 adds a full-stack member portal and PostgreSQL-backed workflows but remains unmerged. Open PR #5 adds legacy member features on top of PR #4 and remains unmerged.
- The configured live URL `https://avcu.grok.me` was not verified as serving any particular branch in this implementation pass. The public repository metadata alone cannot establish its deployment source.
- Existing README content calls the default branch a fictional demo; therefore no banking, card issuance, deposits, payment rails, insurance, or live financial integration should be represented as real without separate proof.

## RCC account-history work added on this branch

- `rcc-history.html`: account overview, annual history, empty source-based ledger, fee and tax status, separate scenario assumptions, and a reconciliation exception.
- `rcc-history.css`: responsive financial workspace styles and print styling.
- `rcc-history.js`: supplied annual closing snapshots, scenario assumption table, annual balance chart, and CSV template exports.
- The supplied 2018–2025 closing snapshots are preserved as supplied inputs and marked unreconciled.
- March 25, 2018 opening balance, transaction-level history, fees, taxes, and source documents remain unknown/pending. No synthetic transactions or fees are created.
- The $5,291,565.00 difference between the supplied 2025 closing balance and separate 2026 opening figure is shown as an unresolved exception.
- The 2026 monthly return assumptions and supplied scenario output are shown separately and not labeled actual performance.

## Security correction added during the current pass

- The Express server now gates `/rcc-history`, `/rcc-history.html`, `/rcc-history.css`, and `/rcc-history.js` behind an authenticated `management` or `super_admin` operator session. The extensionless route is protected too, closing the static-file extension fallback path.
- RCC page and asset responses set `Cache-Control: no-store, private, max-age=0`, `Pragma: no-cache`, and `Vary: Cookie`.
- Production startup no longer silently falls back to the development PostgreSQL URL when `DATABASE_URL` is missing; database access fails closed in production.
- Added an integration test covering anonymous, member, ordinary-operator, and management access to the RCC page and assets. This test has been committed but has not yet been executed in this environment.

## Important remaining security and delivery limitations

- The RCC workspace content is still a static preview behind operator authentication. It does not yet have a database schema/API for source records, import validation, an audit log for RCC-specific edits, or real report generation in PDF/DOCX/XLSX. CSV templates and browser print styling are present; print-to-PDF is a manual browser action.
- Because static files are public when served from a public site, **do not merge or deploy this page to a public production site with named financial details until server-side authentication and corporate-record authorization are implemented**.
- No source statements or transaction records were provided, so the detailed ledger cannot truthfully be populated. No financial values are certified or reconciled.
- Google OAuth is not configured in the previously described AVCU prototype; X/Twitter authentication must remain disabled.
- Gmail OAuth and production API/database hosting remain external configuration tasks documented by PR #4.
- No production deployment or database migration was performed in this pass.


## Verification status for this security pass

- Source changes committed on `feat/rcc-corporate-account-history`; no production deployment or migration was run.
- Automated tests/builds have not been run in this environment. Do not treat the new access-control test as passing until CI or a local PostgreSQL-backed test run confirms it.
