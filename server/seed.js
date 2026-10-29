import { query, close, audit, withTx } from './db.js';
import { hashPassword } from './auth.js';

/**
 * Development seed. These are documented development-only credentials for the
 * preview environment; production deployments must create their own accounts
 * and rotate every password below.
 */
export const MEMBER_PASSWORD = 'Member!Demo2026';
export const OPERATOR_PASSWORD = 'Operator!Demo2026';

export async function seed({ log = console.log } = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Demo seed is disabled in production; provision authorized accounts through the secure operator onboarding process.');
  }
  const existing = await query('SELECT count(*) AS n FROM members WHERE email = $1', ['jordan@avcu.demo']);
  if (Number(existing.rows[0].n) > 0) {
    log('[avcu] seed already applied; skipping');
    return;
  }

  await withTx(async client => {
    const memberHash = await hashPassword(MEMBER_PASSWORD);
    const operatorHash = await hashPassword(OPERATOR_PASSWORD);

    const { rows: members } = await client.query(
      `INSERT INTO members (email, password_hash, full_name, status, application)
       VALUES ('jordan@avcu.demo', $1, 'Jordan Hale', 'verified', '{"channel":"seed"}'::jsonb)
       RETURNING id`, [memberHash]);
    const jordan = members[0];

    const { rows: accounts } = await client.query(
      `INSERT INTO accounts (member_id, kind, name, suffix, balance_cents) VALUES
         ($1,'EVERYDAY','Share Draft','2048',324065),
         ($1,'SAVINGS','Primary Share','3812',684000),
         ($1,'GROWTH','Money Market','6621',190000),
         ($1,'GOAL SAVINGS','Holiday Club','9055',50000)
       RETURNING id, name, balance_cents`, [jordan.id]);
    const draft = accounts.find(a => a.name === 'Share Draft');
    const primary = accounts.find(a => a.name === 'Primary Share');

    const seeded = [
      ['Demo payroll deposit', null, draft.id, 215000, 'deposit', 'posted'],
      ['Harbor Market', draft.id, null, 6435, 'card_auth', 'completed'],
      ['Share transfer', draft.id, primary.id, 25000, 'transfer', 'posted']
    ];
    for (const [memo, fromId, toId, amountCents, type, status] of seeded) {
      const tx = await client.query(
        `INSERT INTO transactions (reference, type, from_account_id, to_account_id, amount_cents, status, memo, submitted_by, submitted_by_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'member') RETURNING id`,
        [`AVCU-SEED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, type, fromId, toId, amountCents, status, memo, jordan.id]);
      if (status === 'posted' || status === 'completed') {
        if (fromId) {
          const { rows } = await client.query('SELECT balance_cents FROM accounts WHERE id = $1', [fromId]);
          await client.query(
            `INSERT INTO ledger_entries (account_id, transaction_id, direction, amount_cents, balance_after_cents, memo)
             VALUES ($1,$2,'debit',$3,$4,$5)`, [fromId, tx.rows[0].id, amountCents, rows[0].balance_cents, memo]);
        }
        if (toId) {
          const { rows } = await client.query('SELECT balance_cents FROM accounts WHERE id = $1', [toId]);
          await client.query(
            `INSERT INTO ledger_entries (account_id, transaction_id, direction, amount_cents, balance_after_cents, memo)
             VALUES ($1,$2,'credit',$3,$4,$5)`, [toId, tx.rows[0].id, amountCents, rows[0].balance_cents, memo]);
        }
      }
    }

    await client.query(
      `INSERT INTO cards (member_id, last4, status, expires, provider_ref)
       VALUES ($1,'4826','active','08/29',$2)`, [jordan.id, `sandbox-card-${jordan.id}`]);

    for (const [email, name, role] of [
      ['super@avcu.demo', 'Avery Sinclair', 'super_admin'],
      ['manager@avcu.demo', 'Morgan Reyes', 'management'],
      ['teller@avcu.demo', 'Casey Nolan', 'operator']
    ]) {
      await client.query(
        `INSERT INTO operators (email, password_hash, name, role) VALUES ($1,$2,$3,$4)`,
        [email, operatorHash, name, role]);
    }

    await client.query(
      `INSERT INTO integration_health (name, adapter, status, detail)
       VALUES ('card-issuer','sandbox','unknown','{}'::jsonb),
              ('payments','sandbox','unknown','{}'::jsonb)`);

    await audit(client, {
      actorType: 'system', action: 'seed.applied', entityType: 'system', entityId: 'dev-seed'
    });
  });
  log('[avcu] seed complete. Dev credentials: jordan@avcu.demo / super@,manager@,teller@avcu.demo');
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed().then(() => close()).then(() => process.exit(0))
    .catch(error => { console.error('[avcu] seed failed:', error.message); process.exit(1); });
}
