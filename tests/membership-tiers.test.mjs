import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTier, MEMBERSHIP_TIERS, TIER_POLICY } from '../server/membership-tiers.js';

test('membership tiers require verified membership before activity can elevate tier', () => {
  assert.equal(calculateTier({ memberStatus: 'pending', accountAgeDays: 500, transactions90Days: 100 }), 'review_required');
  assert.equal(calculateTier({ memberStatus: 'rejected', accountAgeDays: 500, transactions90Days: 100 }), 'review_required');
});

test('activity thresholds assign New, Active, Established and Priority tiers', () => {
  assert.equal(calculateTier({ memberStatus: 'verified', accountAgeDays: 1, transactions90Days: 0 }), 'new_member');
  assert.equal(calculateTier({ memberStatus: 'verified', accountAgeDays: 1, transactions90Days: TIER_POLICY.activeTransactions90Days }), 'active_member');
  assert.equal(calculateTier({ memberStatus: 'verified', accountAgeDays: TIER_POLICY.establishedMinimumAgeDays, transactions90Days: TIER_POLICY.establishedTransactions90Days }), 'established_member');
  assert.equal(calculateTier({ memberStatus: 'verified', accountAgeDays: TIER_POLICY.priorityMinimumAgeDays, transactions90Days: TIER_POLICY.priorityTransactions90Days }), 'priority_service');
});

test('all tier codes have human-readable labels', () => {
  assert.deepEqual(Object.keys(MEMBERSHIP_TIERS).sort(),
    ['active_member', 'established_member', 'new_member', 'priority_service', 'review_required'].sort());
  assert.equal(MEMBERSHIP_TIERS.priority_service, 'Priority Service');
});
