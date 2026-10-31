import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;
const adminUrl = process.env.AVCU_TEST_ADMIN_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error('AVCU_TEST_ADMIN_URL or DATABASE_URL is required for disposable RLS tests');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const app = new Pool({ connectionString: adminUrl, max: 1 });
const role = 'avcu_rls_test_app';
const schema = 'avcu_rls_disposable';

async function asActor(actor, fn) {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE ' + role);
    await client.query(
      "SELECT set_config('app.actor_type',$1,true), set_config('app.actor_id',$2,true), set_config('app.actor_role',$3,true)",
      [actor.type || '', actor.id || '', actor.role || '']
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

before(async () => {
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD 'disposable-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END $$;
    ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS;
    DROP SCHEMA IF EXISTS ${schema} CASCADE;
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.member_records (
      id text PRIMARY KEY, member_id text NOT NULL, body text NOT NULL
    );
    CREATE TABLE ${schema}.support_cases (
      id text PRIMARY KEY, member_id text NOT NULL, body text NOT NULL
    );
    CREATE TABLE ${schema}.audit_events (
      id text PRIMARY KEY, actor_id text, action text NOT NULL
    );
    ALTER TABLE ${schema}.member_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.member_records FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.support_cases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.support_cases FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.audit_events FORCE ROW LEVEL SECURITY;

    CREATE POLICY member_records_owner ON ${schema}.member_records
      USING (current_setting('app.actor_type',true) = 'member'
        AND member_id = current_setting('app.actor_id',true))
      WITH CHECK (current_setting('app.actor_type',true) = 'member'
        AND member_id = current_setting('app.actor_id',true));
    CREATE POLICY support_owner_or_management ON ${schema}.support_cases
      USING ((current_setting('app.actor_type',true) = 'member'
          AND member_id = current_setting('app.actor_id',true))
        OR (current_setting('app.actor_type',true) = 'operator'
          AND current_setting('app.actor_role',true) IN ('management','super_admin')))
      WITH CHECK ((current_setting('app.actor_type',true) = 'member'
          AND member_id = current_setting('app.actor_id',true))
        OR (current_setting('app.actor_type',true) = 'operator'
          AND current_setting('app.actor_role',true) IN ('management','super_admin')));
    CREATE POLICY audit_operator_read ON ${schema}.audit_events
      FOR SELECT USING (current_setting('app.actor_type',true) = 'operator'
        AND current_setting('app.actor_role',true) IN ('auditor','management','super_admin'));

    GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT, INSERT, UPDATE ON ${schema}.member_records TO ${role};
    GRANT SELECT, INSERT, UPDATE ON ${schema}.support_cases TO ${role};
    GRANT SELECT ON ${schema}.audit_events TO ${role};

    INSERT INTO ${schema}.member_records VALUES
      ('m-a','member-a','A private row'), ('m-b','member-b','B private row');
    INSERT INTO ${schema}.support_cases VALUES
      ('c-a','member-a','A case'), ('c-b','member-b','B case');
    INSERT INTO ${schema}.audit_events VALUES ('audit-1','operator-1','reviewed');
  `);

  const { rows } = await admin.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role]
  );
  assert.equal(rows[0].rolsuper, false, 'test application role must not be superuser');
  assert.equal(rows[0].rolbypassrls, false, 'test application role must not bypass RLS');
});

after(async () => {
  await app.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});

test('member RLS returns only the authenticated member rows', async () => {
  const rows = await asActor({ type: 'member', id: 'member-a', role: 'member' },
    c => c.query('SELECT id FROM ' + schema + '.member_records ORDER BY id'));
  assert.deepEqual(rows.rows.map(r => r.id), ['m-a']);
});

test('member cannot read or write another member records', async () => {
  const read = await asActor({ type: 'member', id: 'member-a' },
    c => c.query('SELECT id FROM ' + schema + '.support_cases WHERE id = $1', ['c-b']));
  assert.equal(read.rowCount, 0);
  await assert.rejects(
    asActor({ type: 'member', id: 'member-a' },
      c => c.query("UPDATE " + schema + ".support_cases SET body='tampered' WHERE id='c-b'")),
    /permission|row-level security/i
  );
  await assert.rejects(
    asActor({ type: 'member', id: 'member-a' },
      c => c.query("INSERT INTO " + schema + ".member_records VALUES ('forged','member-b','forged')")),
    /row-level security/i
  );
});

test('anonymous or missing actor context is denied by default', async () => {
  const rows = await asActor({ type: '', id: '', role: '' },
    c => c.query('SELECT id FROM ' + schema + '.member_records'));
  assert.equal(rows.rowCount, 0);
  const audit = await asActor({ type: '', id: '', role: '' },
    c => c.query('SELECT id FROM ' + schema + '.audit_events'));
  assert.equal(audit.rowCount, 0);
});

test('auditor can read audit events but cannot write support or audit records', async () => {
  const rows = await asActor({ type: 'operator', id: 'operator-1', role: 'auditor' },
    c => c.query('SELECT id FROM ' + schema + '.audit_events'));
  assert.deepEqual(rows.rows.map(r => r.id), ['audit-1']);
  await assert.rejects(
    asActor({ type: 'operator', id: 'operator-1', role: 'auditor' },
      c => c.query("INSERT INTO " + schema + ".audit_events VALUES ('audit-2','operator-1','forged')")),
    /permission denied/i
  );
  await assert.rejects(
    asActor({ type: 'operator', id: 'operator-1', role: 'auditor' },
      c => c.query("UPDATE " + schema + ".support_cases SET body='tampered' WHERE id='c-a'")),
    /permission denied|row-level security/i
  );
});

test('management can access operational support rows but not member-private records', async () => {
  const cases = await asActor({ type: 'operator', id: 'manager-1', role: 'management' },
    c => c.query('SELECT id FROM ' + schema + '.support_cases ORDER BY id'));
  assert.deepEqual(cases.rows.map(r => r.id), ['c-a', 'c-b']);
  const members = await asActor({ type: 'operator', id: 'manager-1', role: 'management' },
    c => c.query('SELECT id FROM ' + schema + '.member_records'));
  assert.equal(members.rowCount, 0);
});

test('pooled connection does not retain actor identity across transactions', async () => {
  const first = await asActor({ type: 'member', id: 'member-a', role: 'member' },
    c => c.query("SELECT current_setting('app.actor_id',true) AS actor"));
  assert.equal(first.rows[0].actor, 'member-a');
  const second = await asActor({ type: '', id: '', role: '' },
    c => c.query("SELECT current_setting('app.actor_id',true) AS actor, count(*)::int AS visible FROM " + schema + ".member_records"));
  assert.equal(second.rows[0].actor, '');
  assert.equal(second.rows[0].visible, 0);
});
