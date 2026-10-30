import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRequest, handleWorkflowRequest } from '../netlify/functions/workflow.mjs';
import { rolesForSignup } from '../netlify/functions/identity.mjs';

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
    { type:'bill-payment', sourceAccount:'draft', amountCents:100, purpose:'Missing recipient' },
    { type:'internal-transfer', sourceAccount:'draft', destinationAccount:'primary', amountCents:100, purpose:'Long recipient', recipient:'r'.repeat(101) },
    { type:'bill-payment', sourceAccount:'draft', amountCents:100, purpose:'Long destination', recipient:'Utility', destinationDetails:'d'.repeat(161) }
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

test('workflow API rejects unauthenticated access before database access', async () => {
  const response = await handleWorkflowRequest(new Request('https://avcu.example/api/workflow'), {
    getUser: async () => null,
    getDatabase: () => { throw new Error('database must not be touched for unauthenticated requests'); }
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Sign in is required.');
});

test('member role cannot read the operator queue and staff-only role cannot submit as a member', async () => {
  const databaseMustNotRun = () => { throw new Error('database must not be touched before role authorization'); };
  const queueResponse = await handleWorkflowRequest(new Request('https://avcu.example/api/workflow?scope=queue'), {
    getUser: async () => ({ id:'member-1', roles:['member'] }),
    getDatabase: databaseMustNotRun
  });
  assert.equal(queueResponse.status, 403);
  const submitResponse = await handleWorkflowRequest(new Request('https://avcu.example/api/workflow', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'internal-transfer'})
  }), {
    getUser: async () => ({ id:'operator-1', roles:['operator'] }),
    getDatabase: databaseMustNotRun,
    verifyRequestOrigin: () => {}
  });
  assert.equal(submitResponse.status, 403);
});

test('backend schema has audit history, idempotency, and no seeded account balances', async () => {
  const schema = await readFile(new URL('../netlify/database/migrations/202610290001_create_avcu_workflow.sql', import.meta.url), 'utf8');
  assert.ok(schema.includes('UNIQUE (created_by, idempotency_key)'));
  assert.ok(schema.includes('CREATE TABLE avcu_workflow_audit'));
  assert.ok(schema.includes('CREATE TABLE avcu_account_balances'));
  assert.ok(schema.includes('CREATE TABLE avcu_account_ledger'));
  assert.ok(!/INSERT\s+INTO\s+avcu_account_balances/i.test(schema), 'migration must not fabricate account balances');
});

test('Identity roles are granted only by server-side email allowlists', () => {
  assert.deepEqual(rolesForSignup('member@example.com', [], '', ''), ['member']);
  assert.deepEqual(rolesForSignup('OPERATOR@example.com', [], 'operator@example.com', ''), ['member','operator']);
  assert.deepEqual(rolesForSignup('admin@example.com', [], '', 'admin@example.com'), ['member','operator','admin']);
  assert.deepEqual(rolesForSignup('ordinary@example.com', ['member'], 'operator@example.com', ''), ['member']);
});

test('backend requires Identity roles and prevents operators from reviewing their own requests', async () => {
  const source = await readFile(new URL('../netlify/functions/workflow.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("if (!user) return respond({ error:'Sign in is required.' },401)"));
  assert.ok(source.includes('dependencies.verifyRequestOrigin || verifyRequestOrigin') && source.includes('verifyOrigin(request)'), 'workflow mutations must reject cross-origin requests');
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


test('member history returns only the signed-in member 365-day ledger and monthly totals', async () => {
  const calls = [];
  const database = {
    sql: async (parts, ...values) => {
      const query = parts.join(' ? ');
      calls.push({ query, values });
      if (query.includes('FROM avcu_workflow_requests r') && query.includes('COALESCE')) {
        return [{
          id:'wire-request-1',type:'wire-transfer',source_account:'draft',destination_account:null,
          recipient:'Receiving institution',destination_details:'Secure details on file',currency:'USD',
          amount_cents:2500,purpose:'Birthday gift',status:'approved-awaiting-provider',
          assigned_team:'Payments Operations',assigned_role:'Wire Operator',operator_note:'',
          provider_state:'not-connected',recipient_verified:false,created_at:'2026-10-01T12:00:00.000Z',
          updated_at:'2026-10-01T12:00:00.000Z',audit:[]
        }];
      }
      if (query.includes('FROM avcu_account_ledger l') && query.includes('JOIN avcu_workflow_requests')) {
        return [{
          id:1,request_id:'posted-transfer-1',account_type:'primary',direction:'credit',
          amount_cents:'1250',created_at:'2026-09-15T10:30:00.000Z',request_type:'internal-transfer',
          purpose:'Move savings',recipient:'',currency:'USD'
        }];
      }
      if (query.includes('FROM avcu_account_ledger l') && query.includes('SUM(')) {
        return [{month_key:'2026-09',credits_cents:'1250',debits_cents:'1250',entry_count:2}];
      }
      if (query.includes('FROM avcu_workflow_requests r') && query.includes('SUM(')) {
        return [{month_key:'2026-10',wire_request_cents:'2500',gift_wire_request_cents:'2500',bill_request_cents:'0',request_count:1}];
      }
      return [];
    }
  };
  const response = await handleWorkflowRequest(new Request('https://avcu.example/api/workflow?scope=history'), {
    getUser: async () => ({ id:'member-private-1', roles:['member'] }),
    getDatabase: () => database
  });
  assert.equal(response.status,200);
  const data = await response.json();
  assert.equal(data.period_days,365);
  assert.equal(data.requests[0].id,'wire-request-1');
  assert.equal(data.ledger[0].amount_cents,1250);
  assert.equal(data.monthly[0].credits_cents,1250);
  assert.equal(data.monthly_requests[0].gift_wire_request_cents,2500);
  const ledgerQuery = calls.find(call => call.query.includes('FROM avcu_account_ledger l') && call.query.includes('JOIN avcu_workflow_requests'));
  const memberRequestsQuery = calls.find(call => call.query.includes('FROM avcu_workflow_requests r') && call.query.includes('COALESCE'));
  assert.ok(ledgerQuery.values.includes('member-private-1'), 'ledger must be scoped to the authenticated member');
  assert.ok(memberRequestsQuery.values.includes('member-private-1'), 'requests must be scoped to the authenticated member');
  assert.ok(ledgerQuery.query.includes("interval '365 days'"));
  assert.ok(memberRequestsQuery.query.includes("interval '365 days'"));
});
