import test from "node:test";
import assert from "node:assert/strict";
import { validateLegacyTransactions, compareMigrationTotals } from "../src/domain/migration-validation.mjs";

const valid = (overrides = {}) => ({
  sourceSystem: "legacy-core", sourceTransactionId: "tx-1", sourceAccountId: "acct-1",
  occurredAt: "2024-02-29T12:30:00-05:00", amountMinor: -1234, currency: "USD",
  status: "posted", description: "Legacy withdrawal", reference: "ref-1", ...overrides
});

test("migration validator preserves source timestamp, reference and signed minor units", () => {
  const result = validateLegacyTransactions([valid()]);
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.exceptionCount, 0);
  assert.equal(result.accepted[0].occurredAt, "2024-02-29T12:30:00-05:00");
  assert.equal(result.accepted[0].amountMinor, -1234);
  assert.equal(result.accepted[0].reference, "ref-1");
});

test("invalid and duplicate records are exceptions rather than silently dropped", () => {
  const result = validateLegacyTransactions([valid(), valid(), valid({sourceTransactionId:"tx-3",occurredAt:"not-a-date"})]);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.acceptedCount, 1);
  assert.deepEqual(result.exceptions.map(item => item.code), ["duplicate_source_transaction", "invalid_timestamp"]);
});

test("reconciliation catches missing rows and amount mismatches", () => {
  const source = [{accountId:"acct-1",currency:"USD",status:"posted",count:2,signedAmountMinor:900}];
  const target = [{accountId:"acct-1",currency:"USD",status:"posted",count:1,signedAmountMinor:800}];
  const result = compareMigrationTotals(source, target);
  assert.equal(result.reconciled, false);
  assert.equal(result.differences[0].sourceCount, 2);
  assert.equal(result.differences[0].targetAmountMinor, 800);
});

test("matching reconciliation buckets pass", () => {
  const bucket = [{accountId:"acct-1",currency:"USD",status:"posted",count:2,signedAmountMinor:900}];
  assert.equal(compareMigrationTotals(bucket, bucket).reconciled, true);
});
