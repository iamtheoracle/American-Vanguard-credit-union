import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLegacyTransactions, compareMigrationTotals } from '../server/migration-validation.js';

const valid = (overrides = {}) => ({
  sourceTransactionId: 'tx-1',
  sourceAccountId: 'acct-1',
  occurredAt: '2024-02-29T12:30:00-05:00',
  amountMinor: -1234,
  currency: 'USD',
  status: 'posted',
  description: 'Legacy withdrawal',
  reference: 'ref-1',
  ...overrides
});

test('migration validation preserves source timestamp, references, and signed minor units', () => {
  const result = validateLegacyTransactions([valid()], 'legacy-core');
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.exceptionCount, 0);
  assert.equal(result.accepted[0].occurredAt, '2024-02-29T12:30:00-05:00');
  assert.equal(result.accepted[0].amountMinor, -1234);
  assert.equal(result.accepted[0].reference, 'ref-1');
  assert.equal(result.accepted[0].rowNumber, 1);
});

test('invalid timestamps, missing fields, and duplicate source references become exceptions', () => {
  const result = validateLegacyTransactions([
    valid(),
    valid(),
    valid({ sourceTransactionId: 'tx-3', occurredAt: '2024-02-31T12:30:00Z' }),
    valid({ sourceTransactionId: 'tx-4', currency: 'US' }),
    { sourceTransactionId: 'tx-5' }
  ], 'legacy-core');
  assert.equal(result.sourceCount, 5);
  assert.equal(result.acceptedCount, 1);
  assert.deepEqual(result.exceptions.map(item => item.code), [
    'duplicate_source_transaction', 'invalid_timestamp', 'invalid_field_format', 'missing_required_fields'
  ]);
});

test('source totals reconcile by account, currency, and status', () => {
  const result = validateLegacyTransactions([
    valid({ sourceTransactionId: 'tx-1', amountMinor: 1000 }),
    valid({ sourceTransactionId: 'tx-2', amountMinor: -100 })
  ], 'legacy-core');
  const comparison = compareMigrationTotals(result.totals, [
    { accountId: 'acct-1', currency: 'USD', status: 'posted', count: 2, signedAmountMinor: 900 }
  ]);
  assert.equal(comparison.reconciled, true);
});

test('reconciliation blocks count and signed amount differences', () => {
  const source = [{ accountId: 'acct-1', currency: 'USD', status: 'posted', count: 2, signedAmountMinor: 900 }];
  const target = [{ accountId: 'acct-1', currency: 'USD', status: 'posted', count: 1, signedAmountMinor: 800 }];
  const comparison = compareMigrationTotals(source, target);
  assert.equal(comparison.reconciled, false);
  assert.equal(comparison.differences[0].sourceCount, 2);
  assert.equal(comparison.differences[0].targetAmountMinor, 800);
});

test('migration staging input is bounded and rejects unsafe totals', () => {
  assert.throws(() => validateLegacyTransactions([], ''), /source system/i);
  assert.throws(() => validateLegacyTransactions(Array(1001).fill(valid()), 'legacy-core'), /1000 rows/);
  const result = validateLegacyTransactions([
    valid({ amountMinor: Number.MAX_SAFE_INTEGER }),
    valid({ sourceTransactionId: 'tx-2', amountMinor: 1 })
  ], 'legacy-core');
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.exceptions[0].code, 'amount_total_overflow');
});
