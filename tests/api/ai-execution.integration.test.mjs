import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember } from './helpers.mjs';
import { query } from '../../server/db.js';
import { executeAiAction } from '../../server/ai/execution.js';
import { rememberMemberFact, recallMemberFacts } from '../../server/ai/memory.js';
import { hashPassword } from '../../server/auth.js';

test('AI transfer proposal is brokered, approval-gated, audited and atomic in PostgreSQL', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const response = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie,
    body: { message: 'Transfer $5 from Share Draft to Primary Share' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'succeeded');
  assert.ok(response.data.toolCalls.some(item => item.tool === 'create_transfer_proposal' && item.status === 'ok'));

  const { rows: executions } = await query(
    `SELECT action, status, result FROM ai_execution_idempotency WHERE action = 'transfer.proposal.create'`);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].status, 'succeeded');
  assert.equal(executions[0].result.proposalCreated, true);
  assert.equal(executions[0].result.status, 'pending_approval');

  const { rows: txs } = await query(
    `SELECT status, amount_cents FROM transactions WHERE memo = 'Requested via AI assistant'`);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].status, 'pending_approval');
  assert.equal(Number(txs[0].amount_cents), 500);

  const { rows: ledger } = await query(
    `SELECT count(*)::int AS count FROM ledger_entries WHERE transaction_id = (
       SELECT id FROM transactions WHERE memo = 'Requested via AI assistant' LIMIT 1)`);
  assert.equal(ledger[0].count, 0, 'AI proposal must not post ledger entries');
});

test('concurrent broker retries produce one side effect and replay the committed result', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const me = await api(env.base, '/api/auth/me', { cookie });
  const member = me.data.member;
  const key = 'concurrent-broker-key-0001';
  let executions = 0;
  const execute = async client => {
    executions += 1;
    await client.query('SELECT pg_sleep(0.08)');
    return { operationId: 'single-side-effect' };
  };
  const args = { member, action: 'support.case.create', idempotencyKey: key,
    request: { subject: 'Concurrent retry test' }, execute };
  const results = await Promise.all([executeAiAction(args), executeAiAction(args)]);
  assert.equal(executions, 1);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.deepEqual(results[0].result, results[1].result);
  const { rows } = await query(
    'SELECT count(*)::int AS count FROM ai_execution_idempotency WHERE member_id = $1 AND idempotency_key = $2',
    [member.id, key]);
  assert.equal(rows[0].count, 1);
});

test('broker rollback removes both the idempotency reservation and partial side effect', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const me = await api(env.base, '/api/auth/me', { cookie });
  const member = me.data.member;
  const key = 'broker-rollback-key-0001';
  await assert.rejects(executeAiAction({
    member, action: 'support.case.create', idempotencyKey: key,
    request: { subject: 'Rollback test' },
    execute: async client => {
      await client.query(`INSERT INTO support_cases (member_id, subject) VALUES ($1,$2)`, [member.id, 'must roll back']);
      throw new Error('force transaction rollback');
    }
  }), /force transaction rollback/);
  const { rows } = await query(
    'SELECT count(*)::int AS count FROM ai_execution_idempotency WHERE member_id = $1 AND idempotency_key = $2',
    [member.id, key]);
  assert.equal(rows[0].count, 0);
  const cases = await query('SELECT count(*)::int AS count FROM support_cases WHERE member_id = $1 AND subject = $2',
    [member.id, 'must roll back']);
  assert.equal(cases.rows[0].count, 0);
});

test('member memory recall is isolated between two PostgreSQL identities', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const me = await api(env.base, '/api/auth/me', { cookie });
  const firstId = me.data.member.id;
  const passwordHash = await hashPassword('SecondMember!Pass2026');
  const inserted = await query(
    `INSERT INTO members (email, password_hash, full_name, status, application)
     VALUES ('second-memory-test@avcu.demo',$1,'Second Member','verified','{"channel":"test"}'::jsonb)
     RETURNING id`, [passwordHash]);
  const secondId = inserted.rows[0].id;
  await rememberMemberFact({ memberId: firstId, fact: 'Prefers concise explanations', confirmed: true });
  const firstFacts = await recallMemberFacts({ memberId: firstId, queryText: 'explanations', limit: 5 });
  const secondFacts = await recallMemberFacts({ memberId: secondId, queryText: 'explanations', limit: 5 });
  assert.equal(firstFacts.length, 1);
  assert.equal(firstFacts[0].content, 'Prefers concise explanations');
  assert.equal(secondFacts.length, 0);
});

test('provider outage returns a safe failure and creates no state-changing action', async t => {
  const env = await startTestServer({ aiProvider: 'failing' });
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const response = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'Transfer $5 from Share Draft to Primary Share' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'failed');
  assert.match(response.data.message, /temporarily unavailable/i);
  const { rows } = await query('SELECT count(*)::int AS count FROM ai_execution_idempotency');
  assert.equal(rows[0].count, 0);
});

test('human handoff creates one brokered support case with an auditable execution record', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const response = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'Please connect me to a human representative' }
  });
  assert.equal(response.status, 200);
  assert.ok(response.data.toolCalls.some(item => item.tool === 'create_support_case' && item.status === 'ok'));
  const { rows: cases } = await query(
    `SELECT id FROM support_cases WHERE member_id = (SELECT id FROM members WHERE email = 'jordan@avcu.demo')`);
  assert.equal(cases.length, 1);
  const { rows: executions } = await query(
    `SELECT status, result FROM ai_execution_idempotency WHERE action = 'support.case.create'`);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].status, 'succeeded');
  assert.equal(executions[0].result.caseId, cases[0].id);
});

test('unauthorized AI actions are rejected before any executor can run', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const me = await api(env.base, '/api/auth/me', { cookie });
  let sideEffects = 0;
  await assert.rejects(executeAiAction({
    member: me.data.member, action: 'ledger.post.direct', idempotencyKey: 'unauthorized-action-key-01',
    request: { amountCents: 1 }, execute: async () => { sideEffects += 1; }
  }), error => error.code === 'ai_action_not_allowed');
  assert.equal(sideEffects, 0);
  const { rows } = await query('SELECT count(*)::int AS count FROM ai_execution_idempotency');
  assert.equal(rows[0].count, 0);
});

test('negated transfer language never reaches a state-changing executor', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const response = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'Do not transfer $5 from Share Draft to Primary Share' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.toolCalls.length, 0);
  const { rows } = await query('SELECT count(*)::int AS count FROM ai_execution_idempotency');
  assert.equal(rows[0].count, 0);
});
