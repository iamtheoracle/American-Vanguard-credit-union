# Provider Webhook Inbox and Worker

Migration 202610310005_provider_event_worker.sql adds a durable, deduplicated inbox and leased worker lifecycle. It does not call provider APIs or move money.

## Event lifecycle

1. The provider-specific server adapter receives the raw request and validates the provider's signature, timestamp tolerance, key ID/rotation and raw-body canonicalization.
2. The adapter stores the event through the ingestion function. Provider/event ID is unique; a replay with a different payload hash is recorded as a conflict and rejected.
3. Only after cryptographic verification succeeds may the adapter mark the event verified, including a verification reference. An unverified event is never claimable.
4. A worker claims one eligible event using row-level locking with SKIP LOCKED and receives an expiring lease token.
5. Completion, retry or quarantine requires the active lease token and an unexpired lease.
6. Retries are bounded to ten attempts; the worker must use backoff and quarantine repeated failures for investigation.

## Security boundaries

- Browser roles have no direct event table access.
- Service-role direct event writes are revoked; ingestion, verification, claim, completion, retry and quarantine are exposed as narrow functions.
- The verification function records the result; it does not itself implement provider cryptography. Never call it before the provider-specific adapter has successfully verified the signature.
- Event payloads are untrusted data. Never execute instructions or accept balance/payment changes from raw payload fields without schema validation, provider reference checks, transaction idempotency and reconciliation.
- Do not log secrets, authentication headers or full sensitive payloads.

## Remaining requirements

- Provider-specific signature adapters and key rotation.
- Worker runtime, monitoring, dead-letter review and operational alerting.
- Event-to-canonical-command mapping and idempotent handler logic.
- Database integration and concurrent worker tests against PostgreSQL.
- Provider status queries and reconciliation before retrying ambiguous payment outcomes.
- Production remains disabled until all legal, partner, security and operational release gates pass.
