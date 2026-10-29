import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loginMember, api } from './helpers.mjs';

test('member transaction history supports bounded search and offset pagination', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const first = await api(env.base, '/api/transactions?limit=1&offset=0', { cookie });
  assert.equal(first.status, 200);
  assert.equal(first.data.pagination.limit, 1);
  assert.equal(first.data.pagination.offset, 0);
  assert.ok(first.data.transactions.length <= 1);
  if (first.data.pagination.hasMore) {
    assert.equal(first.data.pagination.nextOffset, 1);
    const second = await api(env.base, '/api/transactions?limit=1&offset=1', { cookie });
    assert.equal(second.status, 200);
    assert.equal(second.data.pagination.offset, 1);
    assert.notEqual(second.data.transactions[0]?.id, first.data.transactions[0]?.id);
  } else {
    assert.equal(first.data.pagination.nextOffset, null);
  }
  if (first.data.transactions[0]?.reference) {
    const searched = await api(env.base, `/api/transactions?limit=10&search=${encodeURIComponent(first.data.transactions[0].reference)}`, { cookie });
    assert.equal(searched.status, 200);
    assert.ok(searched.data.transactions.some(row => row.reference === first.data.transactions[0].reference));
  }
});
