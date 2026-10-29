import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRequest } from '../netlify/functions/workflow.mjs';

test('backend validates internal transfer requests without trusting a client member ID', () => {
  const result = validateRequest({
    type:'internal-transfer', sourceAccount:'draft', destinationAccount:'primary',
    amountCents:1250, purpose:'Move savings'
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.sourceAccount, 'draft');
  assert.equal(result.value.destinationAccount, 'primary');
  assert.equal(result.value.assignedRole, 'Account Operator');
});

test('backend rejects invalid account pairs, amount values, and client-supplied destinations', () => {
  for (const body of [
    { type:'internal-transfer', sourceAccount:'draft', destinationAccount:'draft', amountCents:100, purpose:'Same account' },
    { type:'internal-transfer', sourceAccount:'unknown', destinationAccount:'primary', amountCents:100, purpose:'Unknown source' },
    { type:'internal-transfer', sourceAccount:'draft', destinationAccount:'primary', amountCents:0, purpose:'Zero amount' },
    { type:'internal-transfer', sourceAccount:'draft', destinationAccount:'primary', amountCents:1.5, purpose:'Fractional cents' },
    { type:'bill-payment', sourceAccount:'draft', destinationAccount:'primary', amountCents:100, purpose:'Wrong destination', recipient:'Utility' },
    { type:'bill-payment', sourceAccount:'draft', amountCents:100, purpose:'Missing recipient' }
  ]) assert.ok(validateRequest(body).error, JSON.stringify(body));
});

test('backend rejects FX and check deposit until trusted provider and document storage exist', () => {
  const base = { sourceAccount:'draft', amountCents:1250, purpose:'Service request' };
  const nonUsdWire = validateRequest({ ...base, type:'wire-transfer', recipient:'Receiving bank', destinationDetails:'Bank details on file', currency:'EUR' });
  assert.ok(nonUsdWire.error?.includes('USD'));
  const fx = validateRequest({ ...base, type:'fx', recipient:'Exchange provider', currency:'EUR' });
  assert.ok(fx.unavailable?.includes('Live FX'));
  const check = validateRequest({ ...base, type:'check-deposit' });
  assert.ok(check.unavailable?.includes('Secure check-image storage'));
});

test('backend schema has audit history, idempotency, and no seeded account balances', async () => {
  const schema = await readFile(new URL('../netlify/database/migrations/202610290001_create_avcu_workflow.sql', import.meta.url), 'utf8');
  assert.ok(schema.includes('UNIQUE (created_by, idempotency_key)'));
  assert.ok(schema.includes('CREATE TABLE avcu_workflow_audit'));
  assert.ok(schema.includes('CREATE TABLE avcu_account_balances'));
  assert.ok(schema.includes('CREATE TABLE avcu_account_ledger'));
  assert.ok(!/INSERT\s+INTO\s+avcu_account_balances/i.test(schema), 'migration must not fabricate account balances');
});

test('new Identity accounts receive member role by default, never operator role', async () => {
  const identity = await readFile(new URL('../netlify/functions/identity.mjs', import.meta.url), 'utf8');
  assert.ok(identity.includes("['member']"));
  assert.ok(!identity.includes("['operator']"));
  assert.ok(!identity.includes("['admin']"));
});

test('backend requires Identity roles and prevents operators from reviewing their own requests', async () => {
  const source = await readFile(new URL('../netlify/functions/workflow.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("if (!user) return respond({ error:'Sign in is required.' },401)"));
  assert.ok(source.includes('verifyRequestOrigin(request)'), 'workflow mutations must reject cross-origin requests');
  assert.ok(source.includes("if (!isOperator(user)) return respond({ error:'Authorized operator role required.' },403)"));
  assert.ok(source.includes("if (row.created_by === user.id)"));
  assert.ok(source.includes('function publicRequest(row)'), 'API responses must be explicitly allow-listed');
  assert.ok(source.includes("'actor',CASE WHEN a.actor_id=r.created_by THEN 'Member' ELSE 'Authorized operator' END"), 'audit output must not expose user IDs');
  assert.ok(source.includes('requests:rows.map(publicRequest)'), 'member API must sanitize request rows before returning them');
  assert.ok(!source.includes('return respond({ requests:rows });'), 'raw request rows must not be returned directly');
  assert.ok(source.includes("Approval blocked: verified account records and sufficient available funds are required"));
  assert.ok(source.includes("nextStatus = external.has(row.type) ? 'approved-awaiting-provider'"));
  assert.ok(!source.includes("nextStatus = 'settled'"));
});
