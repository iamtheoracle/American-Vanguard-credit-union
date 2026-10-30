# ECHO AVCU — voice banking assistant

## Product contract
ECHO AVCU is the professional AI-powered voice service for American Vanguard Credit Union. It supports outbound transaction-status calls and inbound customer-service conversations. It is an information and support channel, never a payment authority.

## Existing backend integration
- Runs inside the existing Express + PostgreSQL AVCU service.
- Uses existing member, account, transaction, ledger, and audit records.
- Migration 999_echo_voice.sql creates verified-contact/consent records and a durable call outbox.
- A PostgreSQL trigger records each transaction status transition in the same database transaction as the status update.
- Events are deduplicated by transaction, member, and resulting status.
- Calls are suppressed unless the member has a verified E.164 phone number and explicit current voice-call consent.
- Consent revocation cancels unsent work. A future worker must re-check consent immediately before dispatch.

## Event vocabulary
ECHO may communicate only statuses stored by the banking backend: pending_approval, pending_review, posted, completed, rejected, failed, and reversed. It must distinguish internal approval from provider settlement. A posted/completed status must not be described as bank settlement unless the authorized provider's settlement event and AVCU ledger posting both confirm it.

## Voice architecture
1. Core banking writes a transaction status and ledger entries atomically.
2. The database trigger creates deduplicated ECHO notification work.
3. ECHO resolves the member's verified contact and consent.
4. A production telephony adapter places an outbound call and records provider call IDs.
5. A speech/LLM conversation layer uses a narrow, read-only banking tool allowlist.
6. Webhook callbacks are signature-verified, replay-protected, and update delivery status.
7. Interactions are logged with minimal data; operators can review delivery failures and handoffs.

## AI and customer safety
- The model never receives database credentials, raw account numbers, full card data, passwords, one-time passcodes, or unrestricted SQL.
- Read-only tools may retrieve only the authenticated member's own account/transaction summaries.
- Money movement, beneficiary changes, card replacement, disputes, and profile changes require existing authenticated workflows and step-up verification; AI cannot execute them.
- Never disclose transaction counterparties, balances, or sensitive details until identity is verified. Initial outbound calls should use generic wording and direct the member to the authenticated AVCU app or verified inbound channel.
- Never ask a caller to disclose a password, PIN, CVV, or one-time passcode.
- Identify ECHO as an automated AI assistant calling on behalf of AVCU and provide a human handoff.
- Respect consent, do-not-call status, calling windows, caller-ID rules, recording disclosure, applicable TCPA/FCC/state requirements, and retention policies.

## Production blockers — explicitly not enabled
No live calls are enabled by this change. AVCU must select and contract with a production telephony provider, verify authority to use it, provision verified caller ID and signed webhooks, implement phone verification and auditable consent capture, approve the AI speech provider and data-processing terms, configure retention/recording policy, and complete security/legal/compliance review. No provider credentials are stored in source control. Until then, ECHO queues/suppresses events and reports dispatch disabled; it does not simulate successful calls.

## Scope of this increment
This increment establishes the database event/outbox foundation and consent gate. It does not claim outbound telephony, real-time speech, inbound routing, production credentials, or live banking integrations are active.
