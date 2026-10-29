const required = ["sourceSystem", "sourceTransactionId", "sourceAccountId", "occurredAt", "amountMinor", "currency", "status"];

export function validateLegacyTransactions(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Migration input must be an array");
  const seen = new Set();
  const accepted = [];
  const exceptions = [];
  const totals = new Map();

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const missing = required.filter(key => row?.[key] === undefined || row?.[key] === null || row[key] === "");
    if (missing.length) {
      exceptions.push({ rowNumber, code: "missing_required_fields", fields: missing });
      return;
    }
    if (typeof row.sourceSystem !== "string" || typeof row.sourceTransactionId !== "string" ||
        typeof row.sourceAccountId !== "string" || typeof row.occurredAt !== "string" ||
        !Number.isSafeInteger(row.amountMinor) || !/^[A-Z]{3}$/.test(row.currency) ||
        !["pending", "posted", "settled", "failed", "reversed"].includes(row.status)) {
      exceptions.push({ rowNumber, code: "invalid_field_format" });
      return;
    }
    if (Number.isNaN(Date.parse(row.occurredAt))) {
      exceptions.push({ rowNumber, code: "invalid_timestamp" });
      return;
    }
    const key = `${row.sourceSystem}\u0000${row.sourceTransactionId}`;
    if (seen.has(key)) {
      exceptions.push({ rowNumber, code: "duplicate_source_transaction" });
      return;
    }
    seen.add(key);
    const normalized = {
      sourceSystem: row.sourceSystem,
      sourceTransactionId: row.sourceTransactionId,
      sourceAccountId: row.sourceAccountId,
      occurredAt: row.occurredAt,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status,
      description: typeof row.description === "string" ? row.description : "",
      reference: typeof row.reference === "string" ? row.reference : null,
      original: row
    };
    accepted.push(normalized);
    const bucketKey = `${row.sourceAccountId}\u0000${row.currency}\u0000${row.status}`;
    const bucket = totals.get(bucketKey) || { accountId: row.sourceAccountId, currency: row.currency, status: row.status, count: 0, signedAmountMinor: 0 };
    bucket.count += 1;
    bucket.signedAmountMinor += row.amountMinor;
    totals.set(bucketKey, bucket);
  });

  return {
    sourceCount: rows.length,
    acceptedCount: accepted.length,
    exceptionCount: exceptions.length,
    accepted,
    exceptions,
    totals: [...totals.values()].sort((a, b) =>
      a.accountId.localeCompare(b.accountId) || a.currency.localeCompare(b.currency) || a.status.localeCompare(b.status))
  };
}

export function compareMigrationTotals(sourceTotals, targetTotals) {
  const key = item => `${item.accountId}\u0000${item.currency}\u0000${item.status}`;
  const source = new Map(sourceTotals.map(item => [key(item), item]));
  const target = new Map(targetTotals.map(item => [key(item), item]));
  const keys = new Set([...source.keys(), ...target.keys()]);
  const differences = [];
  for (const bucketKey of keys) {
    const left = source.get(bucketKey);
    const right = target.get(bucketKey);
    if (!left || !right || left.count !== right.count || left.signedAmountMinor !== right.signedAmountMinor) {
      differences.push({
        key: bucketKey,
        sourceCount: left?.count ?? 0,
        targetCount: right?.count ?? 0,
        sourceAmountMinor: left?.signedAmountMinor ?? 0,
        targetAmountMinor: right?.signedAmountMinor ?? 0
      });
    }
  }
  return { reconciled: differences.length === 0, differences };
}
