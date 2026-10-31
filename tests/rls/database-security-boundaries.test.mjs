import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;
const adminUrl = process.env.AVCU_TEST_ADMIN_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error('AVCU_TEST_ADMIN_URL or DATABASE_URL is required');
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const schema = 'avcu_role_matrix_disposable';
const roles = ['member', 'support', 'management', 'auditor', 'admin', 'worker', 'migration']
  .map(name => 'avcu_test_' + name);

async function asRole(role, actor, fn) {
  // pg-connection-string parsing can override sibling config fields. Put the
  // actor credentials in the URL itself so the test cannot silently connect
  // as the privileged AVCU_TEST_ADMIN_URL user.
  const actorUrl = new URL(adminUrl);
  actorUrl.username = role;
  actorUrl.password = 'avcu-disposable-' + role + '-only';
  const client = new pg.Client({ connectionString: actorUrl.toString() });
  await client.connect();
  try {
    await client.query('BEGIN');
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
  } finally { await client.end(); }
}

before(async () => {
  for (const role of roles) {
    const password = 'avcu-disposable-' + role + '-only';
    await admin.query(`DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $do$`);
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  }
  await admin.query(`
    DROP SCHEMA IF EXISTS ${schema} CASCADE;
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.member_records (
      id text PRIMARY KEY, member_id text NOT NULL, body text NOT NULL
    );
    CREATE TABLE ${schema}.support_cases (
      id text PRIMARY KEY, member_id text NOT NULL, assigned_team text, body text NOT NULL
    );
    CREATE TABLE ${schema}.audit_events (
      id text PRIMARY KEY, actor_id text, action text NOT NULL
    );
    CREATE TABLE ${schema}.worker_jobs (
      id text PRIMARY KEY, state text NOT NULL DEFAULT 'queued'
    );
    CREATE SEQUENCE ${schema}.audit_seq;
    CREATE FUNCTION ${schema}.safe_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 7 $$;
    ALTER TABLE ${schema}.member_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.member_records FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.support_cases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.support_cases FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.audit_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.worker_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${schema}.worker_jobs FORCE ROW LEVEL SECURITY;

    CREATE POLICY member_self ON ${schema}.member_records
      USING (current_setting('app.actor_type',true)='member' AND member_id=current_setting('app.actor_id',true))
      WITH CHECK (current_setting('app.actor_type',true)='member' AND member_id=current_setting('app.actor_id',true));
    CREATE POLICY support_team ON ${schema}.support_cases
      USING (current_setting('app.actor_type',true)='operator' AND current_setting('app.actor_role',true) IN ('support','management','admin'))
      WITH CHECK (current_setting('app.actor_type',true)='operator' AND current_setting('app.actor_role',true) IN ('support','management','admin'));
    CREATE POLICY auditor_read ON ${schema}.audit_events FOR SELECT
      USING (current_setting('app.actor_type',true)='operator' AND current_setting('app.actor_role',true) IN ('auditor','management','admin'));
    CREATE POLICY worker_jobs_only ON ${schema}.worker_jobs
      USING (current_setting('app.actor_type',true)='worker') WITH CHECK (current_setting('app.actor_type',true)='worker');

    GRANT USAGE ON SCHEMA ${schema} TO ${roles.join(', ')};
    GRANT SELECT, INSERT, UPDATE ON ${schema}.member_records TO avcu_test_member;
    GRANT SELECT, INSERT, UPDATE ON ${schema}.support_cases TO avcu_test_support, avcu_test_management, avcu_test_admin;
    GRANT SELECT ON ${schema}.audit_events TO avcu_test_auditor, avcu_test_management, avcu_test_admin;
    GRANT SELECT, UPDATE ON ${schema}.worker_jobs TO avcu_test_worker;
    GRANT USAGE, SELECT ON SEQUENCE ${schema}.audit_seq TO avcu_test_worker;
    GRANT EXECUTE ON FUNCTION ${schema}.safe_probe() TO avcu_test_worker;
    GRANT CREATE ON SCHEMA ${schema} TO avcu_test_migration;
    GRANT USAGE, CREATE ON SCHEMA ${schema} TO avcu_test_admin;

    INSERT INTO ${schema}.member_records VALUES ('m1','member-a','A'),('m2','member-b','B');
    INSERT INTO ${schema}.support_cases VALUES ('s1','member-a','team-a','Case A'),('s2','member-b','team-b','Case B');
    INSERT INTO ${schema}.audit_events VALUES ('a1','operator-1','review');
    INSERT INTO ${schema}.worker_jobs VALUES ('j1','queued');
  `);
  const { rows } = await admin.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])",
    [roles]
  );
  assert.equal(rows.length, 7);
  for (const role of rows) {
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    assert.equal(role.rolcreatedb, false);
    assert.equal(role.rolcreaterole, false);
    assert.equal(role.rolcanlogin, true);
  }
});

after(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});

test('member identity sees and mutates only its own rows', async () => {
  const own = await asRole('avcu_test_member',{type:'member',id:'member-a'},c=>c.query(`SELECT id FROM ${schema}.member_records ORDER BY id`));
  assert.deepEqual(own.rows.map(x=>x.id),['m1']);
  const cross = await asRole('avcu_test_member',{type:'member',id:'member-a'},c=>c.query(`UPDATE ${schema}.member_records SET body='x' WHERE id='m2'`));
  assert.equal(cross.rowCount,0);
  await assert.rejects(asRole('avcu_test_member',{type:'member',id:'member-a'},c=>c.query(`INSERT INTO ${schema}.member_records VALUES ('bad','member-b','forged')`)),/row-level security/i);
});

test('support can work support cases but cannot read member or audit records', async () => {
  const cases=await asRole('avcu_test_support',{type:'operator',id:'support-1',role:'support'},c=>c.query(`SELECT id FROM ${schema}.support_cases ORDER BY id`));
  assert.equal(cases.rowCount,2);
  await assert.rejects(asRole('avcu_test_support',{type:'operator',id:'support-1',role:'support'},c=>c.query(`SELECT id FROM ${schema}.member_records`)),/permission denied/i);
  await assert.rejects(asRole('avcu_test_support',{type:'operator',id:'support-1',role:'support'},c=>c.query(`SELECT * FROM ${schema}.audit_events`)),/permission denied/i);
});

test('management has scoped support and audit reads but no ledger-like member writes', async () => {
  const cases=await asRole('avcu_test_management',{type:'operator',id:'manager-1',role:'management'},c=>c.query(`SELECT id FROM ${schema}.support_cases`));
  assert.equal(cases.rowCount,2);
  const audit=await asRole('avcu_test_management',{type:'operator',id:'manager-1',role:'management'},c=>c.query(`SELECT id FROM ${schema}.audit_events`));
  assert.equal(audit.rowCount,1);
  await assert.rejects(asRole('avcu_test_management',{type:'operator',id:'manager-1',role:'management'},c=>c.query(`UPDATE ${schema}.member_records SET body='x'`)),/permission denied/i);
});

test('auditor is read-only and cannot use write or destructive privileges', async () => {
  const rows=await asRole('avcu_test_auditor',{type:'operator',id:'audit-1',role:'auditor'},c=>c.query(`SELECT id FROM ${schema}.audit_events`));
  assert.equal(rows.rowCount,1);
  for (const sql of [
    `INSERT INTO ${schema}.audit_events VALUES ('a2','x','fake')`,
    `UPDATE ${schema}.audit_events SET action='tampered'`,
    `DELETE FROM ${schema}.audit_events`,
    `TRUNCATE ${schema}.audit_events`
  ]) await assert.rejects(asRole('avcu_test_auditor',{type:'operator',id:'audit-1',role:'auditor'},c=>c.query(sql)),/permission denied/i);
});

test('admin remains constrained by explicit grants and forced RLS', async () => {
  const rows=await asRole('avcu_test_admin',{type:'operator',id:'admin-1',role:'admin'},c=>c.query(`SELECT id FROM ${schema}.support_cases`));
  assert.equal(rows.rowCount,2);
  await assert.rejects(asRole('avcu_test_admin',{type:'operator',id:'admin-1',role:'admin'},c=>c.query(`SELECT * FROM ${schema}.worker_jobs`)),/permission denied/i);
});

test('worker can claim/update jobs and execute only its explicitly granted function', async () => {
  const updated=await asRole('avcu_test_worker',{type:'worker',id:'worker-1'},c=>c.query(`UPDATE ${schema}.worker_jobs SET state='running' WHERE id='j1'`));
  assert.equal(updated.rowCount,1);
  const probe=await asRole('avcu_test_worker',{type:'worker',id:'worker-1'},c=>c.query(`SELECT ${schema}.safe_probe() AS value`));
  assert.equal(probe.rows[0].value,7);
  await assert.rejects(asRole('avcu_test_worker',{type:'worker',id:'worker-1'},c=>c.query(`CREATE TABLE ${schema}.forbidden(id int)`)),/permission denied/i);
});

test('migration role alone has schema DDL capability; runtime roles cannot escalate', async () => {
  await asRole('avcu_test_migration',{type:'migration',id:'deploy-1'},c=>c.query(`CREATE TABLE ${schema}.migration_probe(id int)`));
  await assert.rejects(asRole('avcu_test_member',{type:'member',id:'member-a'},c=>c.query(`CREATE TABLE ${schema}.member_ddl_probe(id int)`)),/permission denied/i);
  await assert.rejects(asRole('avcu_test_support',{type:'operator',id:'support-1',role:'support'},c=>c.query('SET ROLE avcu_test_admin')),/permission denied/i);
});

test('pooled connections clear actor claims between transactions', async () => {
  const first=await asRole('avcu_test_member',{type:'member',id:'member-a'},c=>c.query("SELECT current_setting('app.actor_id',true) AS actor"));
  assert.equal(first.rows[0].actor,'member-a');
  const second=await asRole('avcu_test_member',{type:'',id:''},c=>c.query(`SELECT count(*)::int AS visible FROM ${schema}.member_records`));
  assert.equal(second.rows[0].visible,0);
});
