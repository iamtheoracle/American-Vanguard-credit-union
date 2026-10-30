import { createHash } from 'node:crypto';
import { query, withTx, audit } from './db.js';
import { POLICY, requiredApprovalRoleForAmount } from './policy.js';
import { postTwoSided, reverseTransaction } from './ledger.js';
import { queueMemberNotification } from './notifications.js';

/**
 * Approval engine. Approvals are the only path through which pending money
 * movement or membership decisions are executed. Decisions are server-verified:
 * required role, separation of duties (no self-approval), status transitions
 * guarded by conditional UPDATEs so concurrent decisions cannot double-apply.
 */

export async function createTransactionApproval(client, transaction, { submittedByType, submittedBy }) {
  // PostgreSQL BIGINT values are commonly returned as strings by node-postgres.
  // Normalize to integer cents before applying policy or serializing the payload.
  const amountCents = Number(transaction.amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new ApprovalError('Transaction amount must be a positive integer number of cents', 400, 'invalid_amount');
  }
  const requiredRole = requiredApprovalRoleForAmount(amountCents);
  const { rows } = await client.query(
    `INSERT INTO approvals (item_type, member_id, transaction_id, payload, status, required_role, submitted_by, submitted_by_type)
     VALUES ('transaction', $1, $2, $3, 'pending', $4, $5, $6) RETURNING id`,
    [submittedByType === 'member' ? submittedBy : null,
     transaction.id,
     JSON.stringify({ type: transaction.type, amountCents,
       memo: transaction.memo, payee: transaction.payee, reference: transaction.reference,
       source: transaction.memo === 'Requested via AI assistant' ? 'ai_assistant' : 'member' }),
     requiredRole, submittedBy || null, submittedByType]);
  return rows[0].id;
}

export async function createMembershipApproval(client, member, { submittedByType, submittedBy }) {
  const { rows } = await client.query(
    `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
     VALUES ('membership', $1, $2, 'pending', 'management', $3, $4) RETURNING id`,
    [member.id, JSON.stringify({ memberId: member.id, email: member.email, fullName: member.full_name }),
     submittedBy || null, submittedByType || 'member']);
  return rows[0].id;
}

export class ApprovalError extends Error {
  constructor(message, status = 400, code = 'approval_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function roleSatisfies(operatorRole, requiredRole) {
  const order = { operator: 0, management: 1, super_admin: 2 };
  return order[operatorRole] >= order[requiredRole];
}

const DECISIONS = new Set(['approve', 'reject', 'escalate', 'request_info']);

/**
 * Decide an approval. Enforces:
 *  - authenticated operator with the required role (management+ for escalated items)
 *  - separation of duties: the submitter may never decide their own item
 *  - reason required for rejecting financial items
 *  - atomic status transition (concurrent duplicate decisions get 409)
 */
export async function decideApproval({ approvalId, operator, action, reason }) {
  if (!DECISIONS.has(action)) throw new ApprovalError('Unknown decision action', 400);

  const result = await withTx(async client => {
    const { rows } = await client.query(
      `SELECT a.*, t.type AS txn_type, t.amount_cents AS txn_amount, t.id AS txn_id,
              t.memo AS txn_memo, t.payee AS txn_payee, t.reference AS txn_reference,
              t.from_account_id AS txn_from_account_id, t.to_account_id AS txn_to_account_id
       FROM approvals a LEFT JOIN transactions t ON t.id = a.transaction_id
       WHERE a.id = $1 FOR UPDATE OF a`, [approvalId]);
    const approval = rows[0];
    if (!approval) throw new ApprovalError('Approval request not found', 404);
    if (approval.status === 'info_requested' && action !== 'reject' && action !== 'escalate') {
      // Items waiting on information cannot be approved until the member responds.
      if (action === 'approve') throw new ApprovalError('Item is awaiting requested information', 409, 'awaiting_info');
    }
    if (!['pending', 'escalated'].includes(approval.status)) {
      throw new ApprovalError(`Item already decided (${approval.status})`, 409, 'already_decided');
    }

    const requiredRole = approval.status === 'escalated' ? 'management' : approval.required_role;
    // Review actions (request information or escalate) are available to staff
    // who can review the queue; only final approve/reject actions use the
    // configured approval role and monetary policy.
    if (['approve', 'reject'].includes(action) && !roleSatisfies(operator.role, requiredRole)) {
      throw new ApprovalError(`This decision requires the ${requiredRole} role`, 403, 'insufficient_role');
    }

    // Separation of duties: submitter decides nothing on their own item.
    if (approval.submitted_by_type === 'operator' &&
        approval.submitted_by === operator.id) {
      throw new ApprovalError('Separation of duties: you may not decide an item you submitted', 403, 'self_approval');
    }

    const financial = approval.item_type === 'transaction';
    if (['loan', 'money_request'].includes(approval.item_type) && ['approve', 'reject'].includes(action) && (!reason || !String(reason).trim())) {
      throw new ApprovalError('A written decision reason is required for this final decision', 400, 'reason_required');
    }
    if (action === 'reject' && financial && (!reason || !String(reason).trim())) {
      throw new ApprovalError('A written reason is required to reject a financial action', 400, 'reason_required');
    }
    if (action === 'reject' && approval.item_type === 'membership' && (!reason || !String(reason).trim())) {
      throw new ApprovalError('A written reason is required to reject a membership application', 400, 'reason_required');
    }

    // Guard management over their cap: management may not approve beyond the cap.
    const transactionAmountCents = approval.txn_amount == null ? null : Number(approval.txn_amount);
    if (financial && (!Number.isSafeInteger(transactionAmountCents) || transactionAmountCents <= 0)) {
      throw new ApprovalError('Stored transaction amount is invalid', 409, 'invalid_amount');
    }

    if (action === 'approve' && financial && operator.role === 'management' &&
        transactionAmountCents > POLICY.MANAGEMENT_APPROVAL_CAP_CENTS) {
      throw new ApprovalError('Amount exceeds management approval limit; escalate to a super admin', 403, 'over_limit');
    }

    let outcome = null;
    if (action === 'approve') {
      if (approval.item_type === 'transaction') {
        outcome = await executeApprovedTransaction(client, approval, operator);
      } else if (approval.item_type === 'membership') {
        outcome = await executeApprovedMembership(client, approval, operator);
      }
    }

    const nextStatus = action === 'approve' ? 'approved'
      : action === 'reject' ? 'rejected'
      : action === 'escalate' ? 'escalated' : 'info_requested';

    const updated = await client.query(
      `UPDATE approvals SET status = $1, decided_by = $2, decision_reason = $3,
         info_requested = $4, decided_at = now(), updated_at = now()
       WHERE id = $5 AND status IN ('pending','escalated') RETURNING *`,
      [nextStatus, operator.id, reason || null, action === 'request_info' ? (reason || 'Additional information requested') : null, approvalId]);
    if (updated.rowCount === 0) throw new ApprovalError('Item already decided', 409, 'already_decided');

    // Persist terminal business state and notification work in the same
    // transaction as the approval decision, so a process crash cannot lose it.
    if (action === 'reject' && approval.item_type === 'transaction') {
      const rejected = await client.query(
        `UPDATE transactions
         SET status = 'rejected', processed_by = $1, decision_reason = $2, updated_at = now()
         WHERE id = $3 AND status IN ('pending_approval','pending_review')
         RETURNING id`,
        [operator.id, String(reason).trim(), approval.txn_id]);
      if (!rejected.rowCount) throw new ApprovalError('Transaction is no longer pending review', 409, 'already_processed');
    }

    if (action === 'reject' && approval.item_type === 'membership') {
      const rejected = await client.query(
        `UPDATE members SET status = 'rejected', updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [approval.member_id]);
      if (!rejected.rowCount) throw new ApprovalError('Membership is no longer pending review', 409, 'already_processed');
    }

    if (approval.item_type === 'loan') {
      const applicationStatus = nextStatus === 'approved' ? 'approved'
        : nextStatus === 'rejected' ? 'rejected'
        : nextStatus === 'info_requested' ? 'information_required' : 'under_review';
      const updatedLoan = await client.query(
        `UPDATE loan_applications
         SET status = $1,
             decision_reason = CASE WHEN $1 IN ('approved','rejected') THEN $2 ELSE decision_reason END,
             information_requested = CASE WHEN $1 = 'information_required' THEN $2 WHEN $1 = 'submitted' THEN NULL ELSE information_requested END,
             reviewed_at = CASE WHEN $1 IN ('approved','rejected') THEN now() ELSE reviewed_at END,
             updated_at = now()
         WHERE approval_id = $3 AND status IN ('submitted','under_review','information_required')
         RETURNING id, member_id, reference`,
        [applicationStatus, reason ? String(reason).trim() : null, approvalId]);
      if (!updatedLoan.rowCount) throw new ApprovalError('Loan application is no longer in a reviewable state', 409, 'already_processed');
      if (['approved','rejected','information_required'].includes(applicationStatus)) {
        const loan = updatedLoan.rows[0];
        await queueMemberNotification(client, {
          memberId: loan.member_id,
          eventType: 'loan.application_status',
          eventKey: `loan-application:${loan.id}:${applicationStatus}`,
          title: 'Loan application status update',
          body: applicationStatus === 'information_required'
            ? `More information is required for application ${loan.reference}. Sign in to review the request.`
            : `Application ${loan.reference} was ${applicationStatus}. Approval does not mean funds have been disbursed.`,
          subject: 'AVCU loan application status update'
        });
      }
    }

    if (approval.item_type === 'money_request') {
      const requestStatus = nextStatus === 'approved' ? 'approved'
        : nextStatus === 'rejected' ? 'rejected'
        : nextStatus === 'info_requested' ? 'information_required' : 'under_review';
      const updatedRequest = await client.query(
        `UPDATE money_requests
         SET status = $1,
             decision_reason = CASE WHEN $1 IN ('approved','rejected') THEN $2 ELSE decision_reason END,
             information_requested = CASE WHEN $1 = 'information_required' THEN $2 ELSE information_requested END,
             reviewed_at = CASE WHEN $1 IN ('approved','rejected') THEN now() ELSE reviewed_at END,
             updated_at = now()
         WHERE approval_id = $3 AND status IN ('submitted','under_review','information_required')
         RETURNING id, member_id, reference`,
        [requestStatus, reason ? String(reason).trim() : null, approvalId]);
      if (!updatedRequest.rowCount) throw new ApprovalError('Money request is no longer in a reviewable state', 409, 'already_processed');
      if (['approved','rejected','information_required'].includes(requestStatus)) {
        const request = updatedRequest.rows[0];
        await queueMemberNotification(client, {
          memberId: request.member_id,
          eventType: 'money_request.status',
          eventKey: `money-request:${request.id}:${requestStatus}`,
          title: 'Money request status update',
          body: requestStatus === 'information_required'
            ? `More information is required for request ${request.reference}. Sign in to review the request.`
            : `Money request ${request.reference} was ${requestStatus}. No funds were moved by this decision.`,
          subject: 'AVCU money request status update'
        });
      }
    }

    if (nextStatus === 'approved' || nextStatus === 'rejected') {
      const decisionLabel = nextStatus === 'approved' ? 'approved' : 'rejected';
      if (approval.item_type === 'membership' && approval.member_id) {
        await queueMemberNotification(client, {
          memberId: approval.member_id,
          eventType: 'membership.application_decided',
          eventKey: `membership-approval:${approvalId}:${nextStatus}`,
          title: 'Membership application update',
          body: `Your membership application was ${decisionLabel}.`,
          subject: 'AVCU membership application update'
        });
      } else if (approval.item_type === 'transaction' && approval.txn_id) {
        const owners = await client.query(
          `SELECT DISTINCT a.member_id
           FROM accounts a
           JOIN transactions t ON t.from_account_id = a.id OR t.to_account_id = a.id
           WHERE t.id = $1`, [approval.txn_id]);
        for (const owner of owners.rows) {
          await queueMemberNotification(client, {
            memberId: owner.member_id,
            eventType: 'transaction.approval_decided',
            eventKey: `transaction-approval:${approvalId}:${nextStatus}:${owner.member_id}`,
            title: 'Transaction status update',
            body: `A transaction review was ${decisionLabel}. Reference: ${approvalId}.`,
            subject: 'AVCU transaction status update'
          });
        }
      }
    }

    await audit(client, {
      actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: `approval.${action}`, entityType: 'approval', entityId: approvalId,
      metadata: { itemType: approval.item_type, transactionId: approval.txn_id,
        reason: reason || null, requiredRole }
    });

    return { approval: updated.rows[0], outcome };
  });
  return result;
}

async function executeApprovedTransaction(client, approval, operator) {
  const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [approval.txn_id]);
  const txn = rows[0];
  if (!txn) throw new ApprovalError('Linked transaction missing', 409);
  if (!['pending_approval', 'pending_review'].includes(txn.status)) {
    throw new ApprovalError(`Transaction already in state ${txn.status}`, 409, 'already_processed');
  }
  await postTwoSided(client, {
    transactionId: txn.id,
    fromAccountId: txn.from_account_id,
    toAccountId: txn.to_account_id,
    amountCents: txn.amount_cents,
    memo: txn.memo || txn.payee
  });
  await client.query('UPDATE transactions SET processed_by = $1, updated_at = now() WHERE id = $2',
    [operator.id, txn.id]);
  return { transactionId: txn.id, status: 'posted' };
}

async function executeApprovedMembership(client, approval, operator) {
  const memberId = approval.member_id;
  const { rows } = await client.query(
    `UPDATE members SET status = 'verified', updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`, [memberId]);
  if (rows.length === 0) throw new ApprovalError('Membership not in pending state', 409, 'already_processed');
  const member = rows[0];
  await client.query(
    `INSERT INTO accounts (member_id, kind, name, suffix) VALUES
       ($1,'EVERYDAY','Share Draft',$2), ($1,'SAVINGS','Primary Share',$3)`,
    [memberId, String(1000 + Math.floor(Math.random() * 9000)), String(1000 + Math.floor(Math.random() * 9000))]);
  await client.query(
    `INSERT INTO cards (member_id, last4, status, expires, provider_ref)
     VALUES ($1,$2,'active',$3,$4)`,
    [memberId, String(1000 + Math.floor(Math.random() * 9000)).slice(-4), '09/31', `sandbox-card-${memberId}`]);
  return { memberId, status: 'verified' };
}

export async function reversePostedTransaction({ transactionId, operator, reason }) {
  if (!reason || !String(reason).trim()) throw new ApprovalError('A reason is required for a reversal', 400);
  const result = await withTx(async client => {
    const reversal = await reverseTransaction(client, transactionId, {
      actor: { id: operator.id, type: 'operator' }, reason });
    await audit(client, {
      actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: 'ledger.reversal', entityType: 'transaction', entityId: transactionId,
      metadata: { reversalId: reversal.id, reason }
    });
    return reversal;
  });
  return result;
}
