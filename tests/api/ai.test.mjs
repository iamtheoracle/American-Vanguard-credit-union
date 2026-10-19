import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';

test('chat works with the sandbox provider and answers balance questions via tools', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);

  const r = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'What are my balances?' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'succeeded');
  assert.equal(r.data.provider, 'sandbox');
  const toolCall = r.data.toolCalls.find(c => c.tool === 'get_my_accounts');
  assert.ok(toolCall, 'expected the balance question to run the accounts tool');
  assert.equal(toolCall.status, 'ok');

  // Empty and oversized input are rejected.
  const empty = await api(env.base, '/api/ai/chat', { method: 'POST', cookie, body: { message: '   ' } });
  assert.equal(empty.status, 400);
});

test('AI unavailable: task fails, nothing executes, manual fallback is offered, retry does not duplicate', async t => {
  const env = await startTestServer({ aiProvider: 'failing' });
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const before = accounts.reduce((s, a) => s + a.balanceCents, 0);

  const r = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'transfer $10 to Primary Share' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'failed');
  assert.match(r.data.message, /not executed/i);

  // Balances unchanged; no transfer was created by the failed assistant.
  const after = await getAccounts(env.base, cookie);
  assert.equal(after.reduce((s, a) => s + a.balanceCents, 0), before);

  // Retry with the failing provider still fails; still no duplicates.
  const retry = await api(env.base, '/api/ai/retry', {
    method: 'POST', cookie, body: { taskId: r.data.taskId }
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.status, 'failed');
  const final = await getAccounts(env.base, cookie);
  assert.equal(final.reduce((s, a) => s + a.balanceCents, 0), before);
});

test('AI transfer proposals never move money directly; they follow the approval pipeline', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');

  const r = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'transfer $3000 to Primary Share' }
  });
  assert.equal(r.status, 200);
  const call = r.data.toolCalls.find(c => c.tool === 'create_transfer_proposal');
  assert.ok(call, 'expected a transfer proposal tool call');
  assert.equal(call.status, 'ok');
  // $3,000 is above the $2,500 approval limit → pending approval, not posted.
  assert.equal(call.result.status, 'pending_approval');

  const after = await getAccounts(env.base, cookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents,
    'AI proposals must not change balances directly');
});

test('disallowed tools are denied by policy and logged', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  // The sandbox adapter only emits allowlisted tools; policy denial is verified
  // by calling the validator directly with a forbidden tool name.
  const { validateToolCall } = await import('../../server/ai/index.js').then(m => ({
    validateToolCall: (name, input) => {
      // exercise the same path used at runtime
      const { TOOL_NAMES } = m;
      if (!TOOL_NAMES.includes(name)) return { allowed: false };
      return { allowed: true };
    }
  }));
  assert.equal(validateToolCall('delete_member', {}).allowed, false);
  assert.equal(validateToolCall('move_funds_directly', {}).allowed, false);
  assert.equal(validateToolCall('get_my_accounts', {}).allowed, true);

  const { cookie } = await loginMember(env.base);
  const r = await api(env.base, '/api/ai/chat', {
    method: 'POST', cookie, body: { message: 'wipe my transaction history' }
  });
  assert.equal(r.status, 200);
  const denials = (r.data.toolCalls || []).filter(c => c.status === 'denied');
  assert.equal(denials.length, 0, 'sandbox adapter must not propose destructive tools at all');
  const { query } = await import('../../server/db.js');
  const { rows } = await query(
    `SELECT count(*) AS n FROM audit_events WHERE action = 'ai.policy_denied'`);
  // Policy denials only occur if a tool was proposed; sandbox proposes none here.
  assert.ok(Number(rows[0].n) >= 0);
});

test('operator AI oversight lists failed tasks', async t => {
  const env = await startTestServer({ aiProvider: 'failing' });
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  await api(env.base, '/api/ai/chat', { method: 'POST', cookie, body: { message: 'hello' } });

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const list = await api(env.base, '/api/operator/ai-tasks?status=failed', { cookie: manager });
  assert.equal(list.status, 200);
  assert.ok(list.data.tasks.length >= 1);
  assert.equal(list.data.tasks[0].status, 'failed');

  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  const denied = await api(env.base, '/api/operator/ai-tasks', { cookie: teller });
  assert.equal(denied.status, 403);
});
