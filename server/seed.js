import { query, close, audit, withTx } from './db.js';
import { hashPassword } from './auth.js';
import { createTransaction, postTwoSided } from './ledger.js';

/**
 * Development seed. These are documented development-only credentials for the
 * preview environment; production deployments must create their own operator
 * accounts and rotate every password below.
 *
 * Balances are built from ledger entries (opening balance + activity) so the
 * ledger invariant holds for every account from the first page load.
 */
export const MEMBER_PASSWORD = 'Member!Demo2026';
export const OPERATOR_PASSWORD = 'Operator!Demo2026';
export const SECOND_MEMBER_EMAIL = 'priya@avcu.demo';

async function openAccount(client, { memberId, kind, name, suffix, openingCents }) {
  const { rows } = await client.query(
    `INSERT INTO accounts (member_id, kind, name, suffix, balance_cents, opened_at)
     VALUES ($1,$2,$3,$4,$5, now() - interval '120 days') RETURNING *`,
    [memberId, kind, name, suffix, openingCents]);
  const account = rows[0];
  await client.query(
    `INSERT INTO ledger_entries (account_id, direction, amount_cents, balance_after_cents, memo, occurred_at)
     VALUES ($1,'credit',$2,$2,'Opening balance', now() - interval '120 days')`,
    [account.id, openingCents]);
  return account;
}

export async function seed({ log = console.log } = {}) {
  const existing = await query('SELECT count(*) AS n FROM members WHERE email = $1', ['jordan@avcu.demo']);
  if (Number(existing.rows[0].n) > 0) {
    log('[avcu] seed already applied; skipping');
    return;
  }

  await withTx(async client => {
    const memberHash = await hashPassword(MEMBER_PASSWORD);
    const operatorHash = await hashPassword(OPERATOR_PASSWORD);

    const { rows: members } = await client.query(
      `INSERT INTO members (email, password_hash, full_name, username, status, application, email_verified)
       VALUES ('jordan@avcu.demo', $1, 'Jordan Hale', 'jordan.hale', 'verified', '{"channel":"seed"}'::jsonb, TRUE)
       RETURNING id`, [memberHash]);
    const jordan = members[0];

    const draft = await openAccount(client, {
      memberId: jordan.id, kind: 'EVERYDAY', name: 'Share Draft', suffix: '2048', openingCents: 2_316_435
    });
    const primary = await openAccount(client, {
      memberId: jordan.id, kind: 'SAVINGS', name: 'Primary Share', suffix: '3812', openingCents: 659_000
    });
    await openAccount(client, {
      memberId: jordan.id, kind: 'GROWTH', name: 'Money Market', suffix: '6621', openingCents: 190_000
    });
    await openAccount(client, {
      memberId: jordan.id, kind: 'GOAL SAVINGS', name: 'Holiday Club', suffix: '9055', openingCents: 50_000
    });

    const seeded = [
      {
        type: 'deposit', toAccountId: draft.id, amountCents: 215_000, status: 'posted',
        memo: 'Demo payroll deposit', daysAgo: 3
      },
      {
        type: 'card_auth', fromAccountId: draft.id, amountCents: 6_435, status: 'completed',
        memo: 'Harbor Market', daysAgo: 2
      },
      {
        type: 'transfer', fromAccountId: draft.id, toAccountId: primary.id, amountCents: 25_000,
        status: 'posted', memo: 'Share transfer', daysAgo: 5
      }
    ];
    for (const item of seeded) {
      const occurredAt = new Date(Date.now() - item.daysAgo * 86_400_000);
      const tx = await createTransaction(client, {
        type: item.type,
        fromAccountId: item.fromAccountId || null,
        toAccountId: item.toAccountId || null,
        amountCents: item.amountCents,
        status: item.status,
        memo: item.memo,
        description: item.memo,
        occurredAt,
        submittedBy: jordan.id,
        submittedByType: 'member'
      });
      await postTwoSided(client, {
        transactionId: tx.id,
        fromAccountId: item.fromAccountId || null,
        toAccountId: item.toAccountId || null,
        amountCents: item.amountCents,
        memo: item.memo,
        occurredAt
      });
      await client.query('UPDATE transactions SET status = $1, posted_at = $2 WHERE id = $3',
        [item.status, occurredAt, tx.id]);
    }

    await client.query(
      `INSERT INTO cards (member_id, last4, status, expires, provider_ref)
       VALUES ($1,'4826','active','08/29',$2)`, [jordan.id, `sandbox-card-${jordan.id}`]);

    await client.query(
      `INSERT INTO reward_entries (member_id, points, reason) VALUES ($1, 1250, 'Welcome relationship bonus')`,
      [jordan.id]);
    await client.query(
      `INSERT INTO notifications (member_id, title, body, kind) VALUES
         ($1,'Welcome to AVCU','Your member portal is ready. Review your accounts and recent activity.','info')`,
      [jordan.id]);

    // A second verified member makes member-to-member requests testable.
    const { rows: second } = await client.query(
      `INSERT INTO members (email, password_hash, full_name, username, status, application, email_verified)
       VALUES ($1, $2, 'Priya Raman', 'priya.raman', 'verified', '{"channel":"seed"}'::jsonb, TRUE)
       RETURNING id`, [SECOND_MEMBER_EMAIL, memberHash]);
    const priya = second[0];
    await openAccount(client, {
      memberId: priya.id, kind: 'EVERYDAY', name: 'Share Draft', suffix: '7710', openingCents: 128_900
    });
    await openAccount(client, {
      memberId: priya.id, kind: 'SAVINGS', name: 'Primary Share', suffix: '7771', openingCents: 340_000
    });

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
  log('[avcu] seed complete. Dev credentials: jordan@avcu.demo / priya@avcu.demo and super@,manager@,teller@avcu.demo');
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed().then(() => close()).then(() => process.exit(0))
    .catch(error => { console.error('[avcu] seed failed:', error.message); process.exit(1); });
}
