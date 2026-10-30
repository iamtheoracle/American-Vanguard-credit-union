import { getUser, verifyRequestOrigin } from '@netlify/identity';
import { getDatabase } from '@netlify/database';

const accounts = new Set(['draft','primary','market','holiday','business','ira','certificate','retirement401k']);
const types = new Set(['internal-transfer','bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','check-deposit','card-authorization']);
const external = new Set(['bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','check-deposit','card-authorization']);
const routing = {
  'internal-transfer':['Account Services','Account Operator'],
  'bill-payment':['Payments Operations','Payments Operator'],
  'wire-transfer':['Payments Operations','Wire Operator'],
  zelle:['Payments Operations','Zelle Operator'],
  fx:['Treasury Operations','FX Operator'],
  withdrawal:['Payments Operations','Withdrawal Operator'],
  ira:['Retirement Services','Retirement Administrator'],
  '401k':['Retirement Services','Retirement Administrator'],
  'check-deposit':['Deposit Operations','Deposit Operator'],
  'card-authorization':['Card Services','Card Operator']
};
const respond = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control':'no-store, private', 'x-content-type-options':'nosniff' } });
const isOperator = user => Array.isArray(user?.roles) && (user.roles.includes('operator') || user.roles.includes('admin'));
const isMember = user => Array.isArray(user?.roles) && (user.roles.includes('member') || user.roles.includes('admin'));
function publicRequest(row) {
  if (!row) return null;
  return {
    id:row.id,type:row.type,source_account:row.source_account,destination_account:row.destination_account,
    recipient:row.recipient,destination_details:row.destination_details,currency:row.currency,
    amount_cents:row.amount_cents,purpose:row.purpose,status:row.status,assigned_team:row.assigned_team,
    assigned_role:row.assigned_role,operator_note:row.operator_note,provider_state:row.provider_state,
    recipient_verified:row.recipient_verified,created_at:row.created_at,updated_at:row.updated_at,
    audit:Array.isArray(row.audit)?row.audit:[]
  };
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'A request object is required.' };
  const type = String(body.type || '');
  const source = String(body.sourceAccount || '');
  const destination = String(body.destinationAccount || '');
  const amountCents = Number(body.amountCents);
  const purpose = String(body.purpose || '').trim();
  const recipient = String(body.recipient || '').trim();
  const destinationDetails = String(body.destinationDetails || '').trim();
  const currency = String(body.currency || 'USD').toUpperCase();
  if (!types.has(type) || !accounts.has(source)) return { error:'Choose a supported request type and source account.' };
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) return { error:'Amount must be a positive, valid cent value within the configured limit.' };
  if (!purpose || purpose.length > 180) return { error:'Purpose is required and must be 180 characters or fewer.' };
  if (recipient.length > 100) return { error:'Recipient must be 100 characters or fewer.' };
  if (destinationDetails.length > 160) return { error:'Destination details must be 160 characters or fewer.' };
  if (type === 'internal-transfer' && (!accounts.has(destination) || destination === source)) return { error:'Internal transfers require two different supported accounts.' };
  if (type !== 'internal-transfer' && destination) return { error:'A destination account is only valid for internal transfers.' };
  if (['bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','card-authorization'].includes(type) && (!recipient || recipient.length > 100)) return { error:'A recipient or institution name is required.' };
  if (['wire-transfer','withdrawal'].includes(type) && (!destinationDetails || destinationDetails.length > 160)) return { error:'Destination details are required for this request.' };
  if (!/^[A-Z]{3}$/.test(currency)) return { error:'Use a valid three-letter currency code.' };
  if (type !== 'fx' && currency !== 'USD') return { error:'Non-FX requests must be denominated in USD.' };
  if (type === 'check-deposit') return { unavailable:'Secure check-image storage is not configured. No check image or deposit request was accepted.' };
  if (type === 'fx') return { unavailable:'Live FX quoting is not connected. A client-supplied rate or quote cannot be trusted.' };
  return { value:{ type, sourceAccount:source, destinationAccount:type === 'internal-transfer' ? destination : null, amountCents, purpose, recipient, destinationDetails, currency, assignedTeam:routing[type][0], assignedRole:routing[type][1] } };
}

async function audit(client, requestId, actorId, action, details = {}) {
  await client.query('INSERT INTO avcu_workflow_audit (request_id, actor_id, action, details) VALUES ($1,$2,$3,$4::jsonb)', [requestId,actorId,action,JSON.stringify(details)]);
}

export async function handleWorkflowRequest(request, dependencies = {}) {
  const getUserFn = dependencies.getUser || getUser;
  const getDatabaseFn = dependencies.getDatabase || getDatabase;
  const verifyOrigin = dependencies.verifyRequestOrigin || verifyRequestOrigin;
  if (request.method === 'POST' || request.method === 'PATCH') {
    try { verifyOrigin(request); }
    catch { return respond({ error:'Cross-origin request blocked.' },403); }
  }
  let user;
  try { user = await getUserFn(); }
  catch { return respond({ error:'Identity is not configured or could not validate this session.' },503); }
  if (!user) return respond({ error:'Sign in is required.' },401);
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const queue = url.searchParams.get('scope') === 'queue';
    if (queue && !isOperator(user)) return respond({ error:'Operator role required.' },403);
    if (!queue && !isMember(user) && !isOperator(user)) return respond({ error:'Member role required.' },403);
  }
  if (request.method === 'POST' && !isMember(user)) return respond({ error:'Member role required to submit a request.' },403);
  if (request.method === 'PATCH' && !isOperator(user)) return respond({ error:'Authorized operator role required.' },403);
  let db;
  try { db = getDatabaseFn(); }
  catch { return respond({ error:'The secure workflow database is not configured.' },503); }

  if (request.method === 'GET') {
    const queue = url.searchParams.get('scope') === 'queue';
    try {
      const rows = queue
        ? await db.sql`SELECT r.id,r.type,r.source_account,r.destination_account,r.recipient,r.destination_details,r.currency,r.amount_cents,r.purpose,r.status,r.assigned_team,r.assigned_role,r.operator_note,r.provider_state,r.recipient_verified,r.created_at,r.updated_at,COALESCE((SELECT json_agg(json_build_object('created_at',a.created_at,'actor',CASE WHEN a.actor_id=r.created_by THEN 'Member' ELSE 'Authorized operator' END,'action',a.action,'note',a.details->>'note') ORDER BY a.created_at) FROM avcu_workflow_audit a WHERE a.request_id=r.id),'[]'::json) AS audit FROM avcu_workflow_requests r WHERE r.status IN ('pending-approval','needs-information') ORDER BY r.created_at ASC LIMIT 200`
        : await db.sql`SELECT r.id,r.type,r.source_account,r.destination_account,r.recipient,r.destination_details,r.currency,r.amount_cents,r.purpose,r.status,r.assigned_team,r.assigned_role,r.operator_note,r.provider_state,r.recipient_verified,r.created_at,r.updated_at,COALESCE((SELECT json_agg(json_build_object('created_at',a.created_at,'actor',CASE WHEN a.actor_id=r.created_by THEN 'Member' ELSE 'Authorized operator' END,'action',a.action,'note',a.details->>'note') ORDER BY a.created_at) FROM avcu_workflow_audit a WHERE a.request_id=r.id),'[]'::json) AS audit FROM avcu_workflow_requests r WHERE r.created_by = ${user.id} AND r.created_at >= now() - interval '365 days' ORDER BY r.created_at DESC LIMIT 1000`;
      if (queue) return respond({ requests:rows.map(publicRequest) });

      // Only posted ledger entries count as account activity. Requests awaiting a
      // payment provider remain visible separately and never inflate credits/debits.
      const ledgerRows = await db.sql`SELECT l.id,l.request_id,l.account_type,l.direction,l.amount_cents,l.created_at,
        r.type AS request_type,r.purpose,r.recipient,r.currency
        FROM avcu_account_ledger l
        JOIN avcu_workflow_requests r ON r.id=l.request_id
        WHERE l.member_id=${user.id} AND l.created_at >= now() - interval '365 days'
        ORDER BY l.created_at DESC LIMIT 1000`;
      const monthlyRows = await db.sql`SELECT to_char(date_trunc('month',l.created_at),'YYYY-MM') AS month_key,
        SUM(CASE WHEN l.direction='credit' THEN l.amount_cents ELSE 0 END)::bigint AS credits_cents,
        SUM(CASE WHEN l.direction='debit' THEN l.amount_cents ELSE 0 END)::bigint AS debits_cents,
        COUNT(*)::int AS entry_count
        FROM avcu_account_ledger l
        WHERE l.member_id=${user.id} AND l.created_at >= now() - interval '365 days'
        GROUP BY date_trunc('month',l.created_at) ORDER BY month_key DESC`;
      const monthlyRequestRows = await db.sql`SELECT to_char(date_trunc('month',r.created_at),'YYYY-MM') AS month_key,
        SUM(CASE WHEN r.type='wire-transfer' THEN r.amount_cents ELSE 0 END)::bigint AS wire_request_cents,
        SUM(CASE WHEN r.type='wire-transfer' AND r.purpose ILIKE '%gift%' THEN r.amount_cents ELSE 0 END)::bigint AS gift_wire_request_cents,
        SUM(CASE WHEN r.type='bill-payment' THEN r.amount_cents ELSE 0 END)::bigint AS bill_request_cents,
        COUNT(*)::int AS request_count
        FROM avcu_workflow_requests r
        WHERE r.created_by=${user.id} AND r.created_at >= now() - interval '365 days'
        GROUP BY date_trunc('month',r.created_at) ORDER BY month_key DESC`;
      return respond({
        requests:rows.map(publicRequest),
        ledger:ledgerRows.map(row=>({
          id:row.id,request_id:row.request_id,account_type:row.account_type,direction:row.direction,
          amount_cents:Number(row.amount_cents),created_at:row.created_at,request_type:row.request_type,
          purpose:row.purpose,recipient:row.recipient,currency:row.currency
        })),
        monthly:monthlyRows.map(row=>({
          month_key:row.month_key,credits_cents:Number(row.credits_cents||0),
          debits_cents:Number(row.debits_cents||0),entry_count:Number(row.entry_count||0)
        })),
        monthly_requests:monthlyRequestRows.map(row=>({
          month_key:row.month_key,wire_request_cents:Number(row.wire_request_cents||0),
          gift_wire_request_cents:Number(row.gift_wire_request_cents||0),
          bill_request_cents:Number(row.bill_request_cents||0),request_count:Number(row.request_count||0)
        })),
        period_days:365
      });
    } catch { return respond({ error:'The shared workflow queue is unavailable.' },503); }
  }

  if (request.method === 'POST') {
    if (!isMember(user)) return respond({ error:'Member role required to submit a request.' },403);
    const idempotencyKey = request.headers.get('idempotency-key') || '';
    if (!/^[a-zA-Z0-9._:-]{16,100}$/.test(idempotencyKey)) return respond({ error:'A unique idempotency key is required.' },400);
    let body;
    try { body = await request.json(); } catch { return respond({ error:'Request body must be valid JSON.' },400); }
    const validated = validateRequest(body);
    if (validated.error) return respond({ error:validated.error },400);
    if (validated.unavailable) return respond({ error:validated.unavailable },503);
    const v = validated.value;
    let client;
    try { client = await db.pool.connect(); } catch { return respond({ error:'The shared workflow database is unavailable.' },503); }
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO avcu_workflow_requests (created_by,type,source_account,destination_account,recipient,destination_details,currency,amount_cents,purpose,assigned_team,assigned_role,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (created_by,idempotency_key) DO NOTHING RETURNING *`,
        [user.id,v.type,v.sourceAccount,v.destinationAccount,v.recipient,v.destinationDetails,v.currency,v.amountCents,v.purpose,v.assignedTeam,v.assignedRole,idempotencyKey]
      );
      let row = inserted.rows[0];
      if (!row) {
        const prior = await client.query('SELECT * FROM avcu_workflow_requests WHERE created_by=$1 AND idempotency_key=$2', [user.id,idempotencyKey]);
        row = prior.rows[0];
        await client.query('COMMIT');
        return respond({ request:publicRequest(row), idempotentReplay:true });
      }
      await audit(client,row.id,user.id,'Submitted for approval',{type:v.type,amountCents:v.amountCents});
      await client.query('COMMIT');
      return respond({ request:publicRequest(row) },201);
    } catch {
      await client.query('ROLLBACK').catch(()=>{});
      return respond({ error:'The request could not be saved to the shared queue.' },503);
    } finally { client.release(); }
  }

  if (request.method === 'PATCH') {
    if (!isOperator(user)) return respond({ error:'Authorized operator role required.' },403);
    const requestId = url.searchParams.get('id') || '';
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return respond({ error:'A valid request reference is required.' },400);
    let body;
    try { body = await request.json(); } catch { return respond({ error:'Decision body must be valid JSON.' },400); }
    const action = String(body.action || '');
    const note = String(body.note || '').trim();
    if (!['approve','reject','needs-information'].includes(action)) return respond({ error:'Unsupported review decision.' },400);
    if (action !== 'approve' && note.length < 4) return respond({ error:'Add a review note of at least four characters.' },400);
    if (note.length > 240) return respond({ error:'Review note must be 240 characters or fewer.' },400);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM avcu_workflow_requests WHERE id=$1 FOR UPDATE', [requestId]);
      const row = result.rows[0];
      if (!row) { await client.query('ROLLBACK'); return respond({ error:'Request not found.' },404); }
      if (row.created_by === user.id) { await client.query('ROLLBACK'); return respond({ error:'Separation of duties: you cannot review your own request.' },403); }
      if (!['pending-approval','needs-information'].includes(row.status)) { await client.query('ROLLBACK'); return respond({ error:'This request is no longer awaiting review.' },409); }

      let nextStatus = 'pending-approval';
      let nextNote = note;
      if (action === 'reject') nextStatus = 'rejected';
      else if (action === 'needs-information') nextStatus = 'needs-information';
      else if (row.type === 'internal-transfer') {
        const balances = await client.query(
          'SELECT account_type,balance_cents FROM avcu_account_balances WHERE member_id=$1 AND account_type = ANY($2::text[]) FOR UPDATE',
          [row.created_by,[row.source_account,row.destination_account]]
        );
        const byType = new Map(balances.rows.map(item=>[item.account_type,Number(item.balance_cents)]));
        const sourceBalance = byType.get(row.source_account), destinationBalance = byType.get(row.destination_account);
        if (!Number.isSafeInteger(sourceBalance) || !Number.isSafeInteger(destinationBalance) || sourceBalance < Number(row.amount_cents)) {
          await client.query('ROLLBACK');
          return respond({ error:'Approval blocked: verified account records and sufficient available funds are required. No ledger entry was posted.' },409);
        }
        await client.query('UPDATE avcu_account_balances SET balance_cents=balance_cents-$3,updated_at=now() WHERE member_id=$1 AND account_type=$2',[row.created_by,row.source_account,row.amount_cents]);
        await client.query('UPDATE avcu_account_balances SET balance_cents=balance_cents+$3,updated_at=now() WHERE member_id=$1 AND account_type=$2',[row.created_by,row.destination_account,row.amount_cents]);
        await client.query('INSERT INTO avcu_account_ledger (request_id,member_id,account_type,direction,amount_cents) VALUES ($1,$2,$3,$4,$5),($1,$2,$6,$7,$5)',[row.id,row.created_by,row.source_account,'debit',row.amount_cents,row.destination_account,'credit']);
        nextStatus = 'approved';
        nextNote = note || 'Approved after verified account-balance check.';
      } else {
        if (row.type === 'zelle' && row.recipient_verified !== true) {
          await client.query('ROLLBACK');
          return respond({ error:'Approval blocked: recipient verification from the authorized provider is required.' },409);
        }
        if (row.type === 'check-deposit' && !row.secure_document_key) {
          await client.query('ROLLBACK');
          return respond({ error:'Approval blocked: secure front/back check-image storage and review are required.' },409);
        }
        if (row.type === 'fx') {
          await client.query('ROLLBACK');
          return respond({ error:'Approval blocked: a live, server-verified FX quote is required.' },409);
        }
        nextStatus = external.has(row.type) ? 'approved-awaiting-provider' : 'approved';
        nextNote = note || 'Approved for the next processing step. Provider confirmation is required.';
      }
      const updated = await client.query(
        'UPDATE avcu_workflow_requests SET status=$2,operator_note=$3,decision_by=$4,updated_at=now(),provider_state=$5 WHERE id=$1 RETURNING *',
        [row.id,nextStatus,nextNote,user.id,nextStatus==='approved-awaiting-provider'?'not-connected':row.provider_state]
      );
      await audit(client,row.id,user.id,nextStatus,{note:nextNote});
      await client.query('COMMIT');
      return respond({ request:publicRequest(updated.rows[0]) });
    } catch {
      await client.query('ROLLBACK').catch(()=>{});
      return respond({ error:'The review decision failed safely. Recheck the queue before retrying.' },503);
    } finally { client.release(); }
  }

  return respond({ error:'Method not allowed.' },405);
}

export default async function handler(request) {
  return handleWorkflowRequest(request);
}

export const config = { path:'/api/workflow', method:['GET','POST','PATCH'] };
