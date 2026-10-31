# AVCU Jurisdiction and Product Controls

**Status:** implementation foundation only. Every country remains closed for onboarding and every product remains unavailable until explicit approvals and provider routes are recorded.

## Market model

AVCU stores countries individually. Regional groupings are classification aids, not licences:

- United States (US)
- Canada (CA)
- United Kingdom (GB)
- EU/EEA countries, with EU membership and EEA membership represented separately
- Wider Europe outside the EEA, assessed country by country

The UK is not treated as an EU/EEA country. Switzerland is not an EEA member. The EU has 27 members; the EEA adds Iceland, Liechtenstein and Norway. These distinctions matter because a regional label does not itself establish a permission to provide a financial service. See the [European Council explanation of the EEA](https://www.consilium.europa.eu/en/policies/eu-eea-relations/) and [UK government country list](https://www.gov.uk/eu-eea).

## Fail-closed authorization model

A capability is available only when all of the following are true:

1. The country exists in the registry and onboarding is explicitly enabled.
2. An authorization exists for the exact operating entity, country, customer type and capability.
3. Its status is approved, evidence reference and regulator are recorded, and the approval is currently effective and not overdue for review.
4. A provider route tied to that authorization exists, is approved, and supports the requested currency.
5. A separate runtime risk, identity, account-status, limit and transaction authorization check passes.

No authorization row means denied. Unknown country, missing provider route, expired approval, suspended route, unsupported currency, or incomplete evidence means denied. The registry seed deliberately leaves enabled_for_onboarding=false, authorization records absent, and provider routes disabled.

## Supported capability keys

- personal_accounts, business_accounts
- domestic_payments, international_payments
- external_bank_linking
- virtual_cards, physical_cards
- deposits, withdrawals

Each capability is separately approved for individual or business customers. Approval for one product does not imply approval for another.

## Database boundary

Migration 202610310003_jurisdiction_controls.sql adds the country registry, scoped authorization evidence, provider routes and a fail-closed capability predicate. Browser roles have no direct access. Only the trusted backend role is granted execute permission for the predicate. The predicate is a control input, not a substitute for a full legal determination, customer due diligence, sanctions screening, fraud checks, payment authorization, or provider certification.

## Operational rules

- Never enable a country because it appears in a region or because a provider supports it.
- Record the actual contracting/operating entity and scope in every approval.
- Require legal/compliance sign-off and partner evidence before setting approval status to approved.
- Keep sandbox and production routes distinct; sandbox access never grants production permission.
- Recheck approvals, partner status, supported currencies and review dates at runtime.
- Log each allow/deny decision with a reason code and policy version in the future orchestration service.
- No provider credentials, customer money, live account creation or payment execution are introduced by this migration.

## Rollout sequence

1. US: determine state-by-state money transmission and federal obligations, then obtain sponsor-bank and programme approval.
2. Canada: assess RPAA scope and registration, safeguarding, operational risk and local partner requirements before serving Canadian users.
3. UK: determine the applicable FCA permission or authorised-partner model before launch.
4. EU/EEA: select a home-state authorisation/partner model and validate passporting conditions; then assess local conduct, consumer, AML and data requirements.
5. Wider Europe: complete a separate legal and partner assessment per country. Do not infer coverage from SEPA membership or EEA status.

This is an engineering control map, not legal advice. Counsel and regulators determine the actual permissions.

## Release gate

Production banking remains disabled until company formation, legal/regulatory scope, approved partners, compliance operations, security review, tested ledger posting/reconciliation, incident response, customer support, and explicit launch approval are complete.
