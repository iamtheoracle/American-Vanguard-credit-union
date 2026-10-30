# AVCU AI Foundation — five platform capabilities

This document defines the shared AI foundation for member chat, ECHO voice, operator assistance, and future AVCU AI experiences.

## 1. Secure execution foundation

**Authority:** AVCU's authenticated backend, permission policy, approval workflow, PostgreSQL transactions, ledger, and audit log remain authoritative.

Implemented in this increment:
- `server/ai/execution.js` defines an allowlisted execution broker with member binding, action risk tiers, stable request hashing, transactional idempotency, and audit records.
- `server/services-member.js` now forces every AI-originated transfer through the approval path, including amounts below the normal human-initiated approval threshold. AI can propose; it cannot silently post a transfer.
- Existing task-derived transfer idempotency remains in place for retries; AI-created support cases also use a stable task key so retries do not open duplicate cases or duplicate the initial message.

Required before calling the execution foundation complete:
- All current state-changing AI tools (`transfer.proposal.create` and `support.case.create`) now route through the broker. The broker owns the transaction, idempotency reservation, action executor, and audit record; the supplied PostgreSQL client is passed into the domain service so the side effect and broker record commit or roll back together.
- The transfer executor resolves and locks member-owned accounts inside that same transaction. AI transfer proposals remain pending approval and create no ledger entries.
- The broker distinguishes a newly inserted idempotency row from a concurrent replay; a first-time action is not mistaken for an already-processing action.
- The AI layer cannot choose a member ID, permission, approval, or trusted execution context. The authenticated request supplies member identity.
- AI transfer approvals are tagged at creation. Before an operator can approve one, the member must re-enter their password through `POST /api/ai/approvals/:approvalId/confirm`; the server binds that re-authentication to a SHA-256 digest of the exact transaction ID, type, amount, memo, payee, reference, and source/destination accounts. The operator approval path rejects missing or mismatched confirmation. This is separate from, and does not replace, the normal operator approval.

The broker deliberately accepts server-provided executors only. Do not wrap external side effects in a database transaction and assume atomicity.

## 2. Provider-independent model gateway

Implemented in `server/ai/gateway.js` and connected to `server/ai/index.js`:
- OpenRouter, Groq, OpenAI, Anthropic, Gemini, and an existing OpenAI-compatible AVCU endpoint.
- Ordered provider fallback, request timeouts, bounded output, redirect rejection, and per-provider circuit breaking.
- Secrets are read only from server environment variables and never returned by the health/status function.
- The application remains on deterministic sandbox behavior when no provider credentials are configured.

Environment variables:
- `AVCU_AI_PROVIDER`: optional provider override.
- `AVCU_AI_FALLBACKS`: comma-separated fallback order.
- `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
- Provider-specific model variables: `OPENROUTER_MODEL`, `GROQ_MODEL`, `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`.
- Legacy compatible endpoint: `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`.

Provider-native function calling is now implemented for OpenAI-compatible providers (including OpenRouter and Groq), Anthropic, and Gemini. The gateway normalizes structured calls but never executes them; AVCU validates every tool name and argument against its server-side allowlist and strict schemas before invoking the broker or read-only handlers. Malformed arguments fail closed.
- Authenticated `POST /api/ai/chat/stream` streams text deltas using server-sent events, with provider-specific streaming adapters and failover only before the first emitted token. This endpoint is deliberately text-only and cannot execute tools or move money; action requests use the audited `/api/ai/chat` flow. The model is explicitly told not to claim that it performed a banking action.

## 3. Genuine member memory engine

Implemented in `server/ai/memory.js` with migration `1000_ai_foundation.sql` and member routes:
- Member-scoped, PostgreSQL-persisted facts with category, confirmation time, expiry, and full-text recall.
- Save requires an explicit authenticated member action with `confirmed: true`.
- No automatic extraction from chat transcripts.
- Categories are limited to preferences, goals, accessibility, project context, and communication style.
- Secrets and selected sensitive categories are rejected.
- Members can list and delete their own memories; deletion clears the stored content and is audited.
- Retrieved memory is marked as untrusted context, not executable instructions.

This is an explicit-confirmation memory foundation, not a vector database or automatic long-term learning system. Any future semantic embeddings must preserve member isolation, retention, consent, and deletion guarantees.

## 4. Human understanding as a measurable capability

Implemented in `server/ai/understanding.js`:
- Intent classification, risk tier, urgency indicators, negation, observable distress signals, confidence, and clarification requirements.
- Ambiguous high-risk requests are stopped for clarification before model completion.
- Scoring compares predicted intent, risk, clarification need, safety, task completion, and user correction.
- Emotional indicators are observable language signals, not claims that the system knows how a person feels.

The member AI route returns the understanding assessment for observability. Calibration must use human-labelled conversations and user corrections, not unvalidated assumptions.

## 5. Platform benchmark

Implemented in `server/ai/benchmark.js` and `tests/ai-foundation.test.mjs`:
- Deterministic conversation cases for greeting, balance, ambiguous transfer, complete transfer, fraud, negation, and human handoff.
- Metrics for intent, risk, and clarification accuracy.
- Full-platform acceptance gates for unauthorized execution, cross-member memory leakage, duplicate side effects, prompt-injection escapes, sensitive disclosures, handoff failure, understanding score, provider fallback, and p95 latency.
- PostgreSQL integration suites `tests/api/ai-execution.integration.test.mjs` and `tests/api/ai-platform-benchmark.integration.test.mjs` now exercise real database transactions: brokered transfer proposal and no-ledger invariant, concurrent idempotent replay, rollback of both side effect and reservation, cross-member memory isolation, provider outage fail-closed behavior, human handoff case creation, unauthorized tool rejection, and negated-transfer non-execution.
- The suites run through `npm run test:api` alongside the existing API integration tests. The full-platform benchmark derives its safety, isolation, duplicate-side-effect, handoff, provider-fallback and p95 latency metrics from observed test outcomes and measured local API requests. CI's PostgreSQL integration job is the authoritative test execution path for these scenarios.
- Missing platform metrics fail closed; synthetic metric values must never be reported as a production benchmark result.
- Authorized operators can run the deterministic understanding suite at `GET /api/operator/ai/benchmark`; each run is stored and audited.

The full platform suite becomes authoritative only when CI and staging collect real database, security, provider, memory-isolation, concurrency, handoff, and latency results. A passing unit-level understanding suite alone is not proof that the entire platform passed.

## Shared product rules

- Speak naturally and clearly; adapt to the member's level without being patronizing.
- Ask one focused question when the request is ambiguous.
- Acknowledge frustration or urgency without pretending to diagnose emotion.
- Never request passwords, PINs, CVVs, or one-time codes.
- Read-only account information must be scoped to the authenticated member.
- AI-originated money movement is always a proposal/approval workflow, never a direct ledger posting.
- ECHO, chat, and future agents use the same gateway, understanding, memory, execution, and benchmark contracts.
- No live provider credentials are provisioned by this change; tests use mocked providers. Step-up re-authentication has PostgreSQL integration coverage. Provider tool-calling and streaming currently have mocked adapter tests; real staging deployment, live provider validation, and end-to-end operational validation remain outstanding.
