// Central policy constants. Server-side workflow enforcement reads only this file.
export const POLICY = {
  TRANSFER_APPROVAL_LIMIT_CENTS: 250_000,     // share transfers above $2,500 need approval
  DEPOSIT_REVIEW_LIMIT_CENTS: 100_000,        // deposits above $1,000 need operator review
  MANAGEMENT_APPROVAL_CAP_CENTS: 1_000_000,   // management may approve up to $10,000
  SINGLE_TRANSFER_MAX_CENTS: 10_000_000,      // hard cap on a single movement ($100,000)
  CARD_PURCHASE_MAX_CENTS: 1_000_000,         // test authorization cap ($10,000)
  REJECTION_REQUIRES_REASON: ['transfer', 'bill_pay', 'deposit', 'membership'],
  IDEMPOTENCY_RETENTION_HOURS: 48,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300,
  AI_TIMEOUT_MS: 10_000,
  AI_MAX_TOOL_CALLS_PER_MESSAGE: 3,
  INTEGRATION_MAX_RETRIES: 3,
  INTEGRATION_TIMEOUT_MS: 8_000,
  CIRCUIT_THRESHOLD: 5,
  CIRCUIT_COOLDOWN_MS: 30_000
};

export function requiredApprovalRoleForAmount(amountCents) {
  if (amountCents > POLICY.MANAGEMENT_APPROVAL_CAP_CENTS) return 'super_admin';
  return 'management';
}
