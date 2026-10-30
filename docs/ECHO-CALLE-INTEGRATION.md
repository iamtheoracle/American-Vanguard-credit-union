# ECHO AVCU — CALL-E provider integration

## Decision

Use [CALL-E Integrations](https://github.com/CALLE-AI/call-e-integrations) as the outbound phone-execution provider pattern for ECHO. Keep AVCU as the system of record and policy authority. CALL-E is not given banking credentials, account access, ledger access, or authority to move money.

The integration targets the current CALL-E Developer API Calls v2 contract:
- `POST https://api.heycall-e.com/v2/calls` with a stable `Idempotency-Key`.
- `GET /v2/calls/{resource_id}` for recovery and status reads.
- Interpret `result_status` separately from execution `status`; a completed call can still have a pending or unavailable result.
- Do not use the legacy v1 call-task API or legacy MCP Plan/Run tool names for new integration work.

## Implemented adapter boundary

`server/integrations/calle.js` provides:
- A fixed production API host; redirects are rejected.
- API key read only from `CALLE_API_KEY`; never from a request body or source file.
- Explicit `ECHO_CALL_DISPATCH_ENABLED=true` feature gate; default is disabled.
- Preflight requirements for verified phone, active consent, do-not-call clearance, calling window, approved caller ID, and compliance approval.
- E.164 recipient validation and deterministic idempotency key derived from the AVCU event key.
- A generic, privacy-preserving voice task. It does not disclose transaction status, amounts, balances, counterparties, or account references.
- Provider resource ID persistence requirement and read-only recovery function.
- No webhook receiver: use authenticated polling because the currently documented CALL-E API workflow describes persisted Call reads and the repository's current guidance says webhook callbacks are unsigned.

The adapter is a transport boundary, not a worker. It is not yet wired to the outbox and cannot dispatch by itself. No live call has been placed by this implementation.

## Required next implementation steps

1. Add a KMS-backed phone decrypt service and one-time phone verification/consent capture. Never accept a client-supplied `phoneVerified` or `consentActive` flag.
2. Implement an AVCU worker that claims outbox rows with recoverable leases, then re-checks consent, do-not-call state, calling window, caller ID approval, and compliance status inside trusted server code immediately before submission.
3. Persist CALL-E's top-level resource `id`, provider status, result readiness, retry count, and last error in a dedicated provider-attempt record. Never create a second logical call after an uncertain POST; retry only with the same event-derived idempotency key or recover by the saved resource ID.
4. Poll the existing resource until `result_status` is final, using bounded backoff. Treat `available`, `unavailable`, and `not_applicable` as distinct terminal states. Do not infer a successful conversation from `status=completed`.
5. Add mocked contract tests for create, timeout/uncertain acceptance, duplicate retry, missing resource ID, read recovery, invalid response, disabled dispatch, and every preflight gate.
6. Complete legal, security, vendor, privacy, retention, recording, caller-ID, and TCPA/FCC/state review before enabling dispatch.

## Product boundary

This CALL-E API integration supports outbound single-recipient calls. It does not by itself provide an inbound customer-service number or an authenticated ongoing banking conversation. Build inbound ECHO separately behind AVCU's authentication and step-up verification. Any conversational tools must be narrowly read-only and member-scoped; money movement and profile changes remain in existing authenticated AVCU workflows.

## Configuration

Required secrets/configuration:
- `CALLE_API_KEY`: production API key in the deployment secret manager.
- `ECHO_CALL_DISPATCH_ENABLED`: remains unset or `false` until every production blocker is signed off.

Do not place credentials in GitHub, frontend code, logs, tests, issue comments, or chat. The feature gate alone is not compliance approval. Keep dispatch disabled until the worker and all controls above are complete.
