import { query, audit } from './db.js';

export const MEMBERSHIP_TIERS = Object.freeze({
  new_member: 'New Member',
  active_member: 'Active Member',
  established_member: 'Established Member',
  priority_service: 'Priority Service',
  review_required: 'Review Required'
});

/** Deterministic activity-based tier policy; thresholds are centralized here. */
export const TIER_POLICY = Object.freeze({
  activeTransactions90Days: 3,
  establishedTransactions90Days: 10,
  establishedMinimumAgeDays: 90,
  priorityTransactions90Days: 25,
  priorityMinimumAgeDays: 180
});

export function calculateTier({ memberStatus, accountAgeDays, transactions90Days }) {
  if (memberStatus !== 'verified') return 'review_required';
  if (accountAgeDays >= TIER_POLICY.priorityMinimumAgeDays &&
      transactions90Days >= TIER_POLICY.priorityTransactions90Days) return 'priority_service';
  if (accountAgeDays >= TIER_POLICY.establishedMinimumAgeDays &&
      transactions90Days >= TIER_POLICY.establishedTransactions90Days) return 'established_member';
  if (transactions90Days >= TIER_POLICY.activeTransactions90Days) return 'active_member';
  return 'new_member';
}

export async function recalculateMemberTier(memberId) {
  const { rows } = await query(
    `SELECT m.status, m.membership_tier AS "membershipTier", m.tier_override AS "tierOverride",
            EXTRACT(EPOCH FROM (now() - m.created_at))/86400 AS "ageDays",
            (SELECT count(DISTINCT t.id) FROM transactions t
             JOIN accounts a ON a.id = t.from_account_id OR a.id = t.to_account_id
             WHERE a.member_id = m.id AND t.status IN ('posted','completed','reversed')
               AND t.created_at >= now() - interval '90 days') AS "activity90Days"
     FROM members m WHERE m.id = $1`, [memberId]);
  const member = rows[0];
  if (!member) return null;
  const calculated = calculateTier({
    memberStatus: member.status,
    accountAgeDays: Number(member.ageDays || 0),
    transactions90Days: Number(member.activity90Days || 0)
  });
  const next = member.tierOverride || calculated;
  if (next !== member.membershipTier) {
    await query(
      `UPDATE members SET membership_tier = $2, tier_updated_at = now() WHERE id = $1`,
      [memberId, next]);
    await query(
      `INSERT INTO membership_tier_history (member_id, previous_tier, new_tier, reason)
       VALUES ($1,$2,$3,$4)`,
      [memberId, member.membershipTier, next, member.tierOverride ? 'Configured operator override' : 'Automatic activity recalculation']);
  }
  return { tier: next, label: MEMBERSHIP_TIERS[next], calculatedTier: calculated,
    activity90Days: Number(member.activity90Days || 0), accountAgeDays: Math.floor(Number(member.ageDays || 0)),
    overridden: Boolean(member.tierOverride) };
}

export async function overrideMemberTier({ memberId, tier, reason, operator }) {
  if (!Object.hasOwn(MEMBERSHIP_TIERS, tier)) {
    const error = new Error('Unknown membership tier');
    error.status = 400;
    throw error;
  }
  const note = String(reason || '').trim();
  if (note.length < 5 || note.length > 500) {
    const error = new Error('Provide an override reason between 5 and 500 characters');
    error.status = 400;
    throw error;
  }
  const { rows } = await query(
    'SELECT membership_tier AS "membershipTier" FROM members WHERE id = $1', [memberId]);
  if (!rows[0]) {
    const error = new Error('Member not found');
    error.status = 404;
    throw error;
  }
  const previous = rows[0].membershipTier;
  await query(
    `UPDATE members SET tier_override = $2, tier_override_reason = $3,
       membership_tier = $2, tier_updated_at = now() WHERE id = $1`,
    [memberId, tier, note]);
  await query(
    `INSERT INTO membership_tier_history (member_id, previous_tier, new_tier, reason, changed_by_type, changed_by)
     VALUES ($1,$2,$3,$4,'operator',$5)`,
    [memberId, previous, tier, note, operator.id]);
  await audit(null, { actorType: 'operator', actorId: operator.id, actorRole: operator.role,
    action: 'membership.tier.override', entityType: 'member', entityId: memberId,
    metadata: { previous, tier, reason: note } });
  return { tier, label: MEMBERSHIP_TIERS[tier], overridden: true };
}

export async function clearMemberTierOverride(memberId, operator) {
  await query('UPDATE members SET tier_override = NULL, tier_override_reason = NULL WHERE id = $1', [memberId]);
  await audit(null, { actorType: 'operator', actorId: operator.id, actorRole: operator.role,
    action: 'membership.tier.override_cleared', entityType: 'member', entityId: memberId });
  return recalculateMemberTier(memberId);
}
