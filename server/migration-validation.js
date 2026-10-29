const REQUIRED_FIELDS = ['sourceTransactionId', 'sourceAccountId', 'occurredAt', 'amountMinor', 'currency', 'status'];
const VALID_STATUSES = new Set(['pending', 'posted', 'settled', 'failed', 'reversed']);

export function validateLegacyTransactions(rows, sourceSystem) {
  if (!Array.isArray(rows)) throw new TypeError('Migration input must be an array');
  if (typeof sourceSystem !== 'string' || !sourceSystem.trim() || sourceSystem.length > 120) {
    throw new TypeError('A valid source system is required');
  }
  if (rows.length > 1000) throw new RangeError('A staging batch may contain at most 1000 rows');

  const seen = new Set();
  const accepted = [];
  const exceptions = [];
  const totals = new Map();

  rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const missing = REQUIRED_FIELDS.filter(key => row[key] === undefined || row[key] === null || row[key] === '');
    if (missing.length) {
      exceptions.push({ rowNumber, code: 'missing_required_fields', fields: missing });
      return;
    }
    if (typeof row.sourceTransactionId !== 'string' || row.sourceTransactionId.length > 250 ||
        typeof row.sourceAccountId !== 'string' || row.sourceAccountId.length > 250 ||
        typeof row.occurredAt !== 'string' || row.occurredAt.length > 100 ||
        !Number.isSafeInteger(row.amountMinor) || !/^[A-Z]{3}$/.test(row.currency) ||
        typeof row.status !== 'string' || !VALID_STATUSES.has(row.status)) {
      exceptions.push({ rowNumber, code: 'invalid_field_format', fields: [] });
      return;
    }
    const timestampParts = row.occurredAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/);
    const timestampValid = timestampParts && !Number.isNaN(Date.parse(row.occurredAt)) &&
      Number(timestampParts[2]) >= 1 && Number(timestampParts[2]) <= 12 &&
      Number(timestampParts[3]) >= 1 &&
      Number(timestampParts[3]) <= new Date(Date.UTC(Number(timestampParts[1]), Number(timestampParts[2]), 0)).getUTCDate() &&
      Number(timestampParts[4]) <= 23 && Number(timestampParts[5]) <= 59 && Number(timestampParts[6]) <= 59 &&
      (!timestampParts[7] || (Number(timestampParts[7]) <= 23 && Number(timestampParts[8]) <= 59));
    if (!timestampValid) {
      exceptions.push({ rowNumber, code: 'invalid_timestamp', fields: ['occurredAt'] });
      return;
    }
    const sourceKey = `${sourceSystem}\u0000${row.sourceTransactionId}`;
    if (seen.has(sourceKey)) {
      exceptions.push({ rowNumber, code: 'duplicate_source_transaction', fields: ['sourceTransactionId'] });
      return;
    }
    const bucketKey = `${row.sourceAccountId}\u0000${row.currency}\u0000${row.status}`;
    const previous = totals.get(bucketKey);
    const nextTotal = (previous?.signedAmountMinor || 0) + row.amountMinor;
    if (!Number.isSafeInteger(nextTotal)) {
      exceptions.push({ rowNumber, code: 'amount_total_overflow', fields: ['amountMinor'] });
      return;
    }

    seen.add(sourceKey);
    const normalized = {
      rowNumber,
      sourceSystem,
      sourceTransactionId: row.sourceTransactionId,
      sourceAccountId: row.sourceAccountId,
      occurredAt: row.occurredAt,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status,
      description: typeof row.description === 'string' ? row.description.slice(0, 2000) : '',
      reference: typeof row.reference === 'string' ? row.reference.slice(0, 250) : null,
      original: row
    };
    accepted.push(normalized);
    const bucket = previous || {
      accountId: row.sourceAccountId, currency: row.currency, status: row.status,
      count: 0, signedAmountMinor: 0
    };
    bucket.count += 1;
    bucket.signedAmountMinor = nextTotal;
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
