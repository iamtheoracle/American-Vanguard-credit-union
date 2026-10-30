# AVCU production-staging validation

This runbook is a gate, not a declaration of production readiness. Run only in an isolated staging environment with synthetic members and provider credentials scoped to staging.

## 1. Preconditions

- Deploy the exact reviewed PR commit to a staging-only environment.
- Use a dedicated PostgreSQL database with migrations applied and synthetic member/operator identities.
- Set `NODE_ENV=staging`; do not use production member data.
- Configure one approved provider and, if failover is being tested, a separate fallback provider. Store credentials only in the secret manager.
- Confirm request/response bodies, authorization headers, phone values, tokens and model prompts are redacted from application and proxy logs.
- Keep ECHO dispatch disabled throughout the AI gateway tests.

## 2. Automated checks

Run the deterministic checks against the staging database:

```sh
npm ci
npm run check
npm test
npm run test:api
```

The API suite must include the AI execution, broker concurrency, rollback, member-memory isolation, transfer approval/no-ledger, provider outage and handoff cases.

Run the live-provider smoke test only after explicit staging approval:

```sh
AVCU_STAGING_APPROVED=true npm run test:ai:staging
```

The script verifies a real provider-native structured function-call response and a real streaming response. Its test function is a harmless marker and is never executed. It reports provider/model and timing only; it does not print credentials or prompts.

## 3. Required fault-injection scenarios

- Force the primary provider to return 429 and 5xx; confirm configured fallback works and the selected provider is recorded.
- Disable all configured providers; confirm the member sees a safe unavailable response and no tool action is executed.
- Return malformed tool JSON, unknown tool names and invalid argument types; confirm the server rejects each before execution.
- Interrupt a stream before the first token; confirm fallback. Interrupt after the first token; confirm the stream fails rather than restarting and duplicating partial text.
- Send duplicate concurrent transfer-proposal requests; confirm one proposal and one broker record.
- Force the broker executor to fail; confirm the side effect and idempotency reservation roll back together.
- Attempt cross-member memory reads and cross-member approval confirmation; confirm denial.
- Confirm AI transfer member re-authentication is bound to the exact transaction payload and normal operator approval is still required.
- Confirm the streaming endpoint cannot invoke tools and cannot create a transfer or support case.

## 4. ECHO remains separately gated

Do not enable dispatch until all of the following are independently reviewed and tested:

- Phone ownership challenge with expiry, attempt limits and replay protection.
- Explicit outbound-call consent capture with purpose, disclosure version, timestamp and source; revocation cancels pending jobs.
- KMS-backed encryption for phone data, with key rotation and access audit; searchable fingerprints must not expose the phone number.
- Durable worker leasing with lease expiry, owner checks, bounded retries, dead-letter handling and duplicate-event protection.
- Telephony provider credentials stored in a secret manager; verified caller ID, opt-out handling, calling windows, recording disclosures and delivery callbacks.
- Member privacy controls, data retention/deletion, incident response, TCPA/FCC/state-law review and operational on-call ownership.
- Human review of the generic notification wording and confirmation that no sensitive transaction details are disclosed in an outbound call.

## 5. Release acceptance evidence

Attach the exact commit SHA, migration version, test logs, provider/model IDs, fallback outcomes, p50/p95/p99 latency, error rates, redaction evidence, concurrency results and signed security/compliance approvals to the release record.

A green CI run or a successful smoke test alone does not authorize live banking operations, money movement, or ECHO outbound calling.
