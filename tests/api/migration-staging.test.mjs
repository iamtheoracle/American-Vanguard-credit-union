import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loginOperator, api } from './helpers.mjs';
import { query } from '../../server/db.js';

test('legacy migration staging preserves provenance and blocks cutover on exceptions', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const rows = [
    {
      sourceTransactionId: 'legacy-tx-1', sourceAccountId: 'legacy-account-7',
      occurredAt: '2024-02-29T12:30:00-05:00', amountMinor: -1234,
      currency: 'USD', status: 'posted', description: 'Legacy withdrawal', reference: 'legacy-ref-1'
    },
    {
      sourceTransactionId: 'legacy-tx-1', sourceAccountId: 'legacy-account-7',
      occurredAt: '2024-02-29T12:30:00-05:00', amountMinor: -1234,
      currency: 'USD', status: 'posted', description: 'Duplicate source record'
    },
    {
      sourceTransactionId: 'legacy-tx-3', sourceAccountId: 'legacy-account-8',
      occurredAt: '2024-02-31T12:30:00Z', amountMinor: 500,
      currency: 'USD', status: 'posted'
    }
  ];
  const response = await api(env.base, '/api/operator/migrations/validate', {
    method: 'POST', cookie,
    body: { sourceSystem: 'legacy-core-test', sourceFileName: 'authorized-export.json', rows }
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.batch.sourceCount, 3);
  assert.equal(response.data.batch.acceptedCount, 1);
  assert.equal(response.data.batch.exceptionCount, 2);
  assert.equal(response.data.batch.status, 'blocked');
  assert.match(response.data.batch.sourcePayloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(response.data.cutoverAllowed, false);

  const batchId = response.data.batch.id;
  const detail = await api(env.base, `/api/operator/migrations/${batchId}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.exceptions.length, 2);
  assert.equal(detail.data.cutoverAllowed, false);

  const { rows: staged } = await query(
    'SELECT row_number, validation_status, original_timestamp, amount_minor, raw_record FROM migration_staged_transactions WHERE batch_id = $1 ORDER BY row_number',
    [batchId]
  );
  assert.equal(staged.length, 3);
  assert.equal(staged[0].original_timestamp, '2024-02-29T12:30:00-05:00');
  assert.equal(Number(staged[0].amount_minor), -1234);
  assert.equal(staged[1].validation_status, 'exception');
  assert.equal(staged[2].original_timestamp, '2024-02-31T12:30:00Z');

  const list = await api(env.base, '/api/operator/migrations?limit=10', { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.data.batches.some(batch => batch.id === batchId));
});
