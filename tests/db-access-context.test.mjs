import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
const db = await import('../server/db.js');

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [], rowCount: 0 }; },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params) { calls.push({ sql: 'POOL ' + String(sql), params }); return { rows: [], rowCount: 0 }; }
  };
  return { pool, calls };
}

test('cookie-authenticated request actor is transaction-scoped and query uses pinned connection', async () => {
  const { pool, calls } = fakePool();
  db.configurePoolForTests(pool);
  const req = {};
  const res = new EventEmitter();
  res.writableFinished = false;
  let nextCalled = false;
  db.bindActorContext(req, res, { type: 'member', id: 'member-1', role: 'member' }, async error => {
    assert.ifError(error);
    nextCalled = true;
    assert.deepEqual(db.currentActor(), { type: 'member', id: 'member-1', role: 'member' });
    await db.query('SELECT member-owned row');
    await db.withTx(async client => client.query('UPDATE member-owned row'));
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextCalled, true);
  assert.ok(calls.some(c => c.sql.includes("set_config('app.actor_type'")));
  assert.ok(calls.some(c => c.sql === 'SELECT member-owned row'));
  assert.ok(calls.some(c => c.sql.startsWith('SAVEPOINT avcu_sp_')));
  assert.equal(calls.some(c => c.sql.startsWith('POOL SELECT member-owned row')), false);
  res.writableFinished = true;
  res.emit('finish');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(c => c.sql === 'COMMIT'));
  assert.ok(calls.some(c => c.sql === 'RELEASE'));
  assert.equal(db.currentActor(), null);
});

test('request close before finish rolls back and releases its connection', async () => {
  const { pool, calls } = fakePool();
  db.configurePoolForTests(pool);
  const res = new EventEmitter();
  res.writableFinished = false;
  db.bindActorContext({}, res, { type: 'operator', id: 'operator-1', role: 'auditor' }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  res.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(c => c.sql === 'ROLLBACK'));
  assert.ok(calls.some(c => c.sql === 'RELEASE'));
});

test('actor identity cannot be replaced by nested middleware', async () => {
  const { pool } = fakePool();
  db.configurePoolForTests(pool);
  const res = new EventEmitter();
  res.writableFinished = false;
  await new Promise(resolve => {
    db.bindActorContext({}, res, { type: 'member', id: 'member-1', role: 'member' }, () => {
      db.bindActorContext({}, res, { type: 'operator', id: 'operator-1', role: 'super_admin' }, error => {
        assert.match(error.message, /Cannot change actor identity/);
        res.writableFinished = true;
        res.emit('finish');
        resolve();
      });
    });
  });
});
