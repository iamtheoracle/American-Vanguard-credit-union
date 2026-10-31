import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const adminUrl = process.env.AVCU_TEST_ADMIN_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error('AVCU_TEST_ADMIN_URL or DATABASE_URL is required');
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
const schema = 'avcu_privilege_surface_disposable';
const roles = ['member','support','management','auditor','admin','worker','migration'].map(x => 'avcu_test_' + x);

async function actor(role, sql, params = []) {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = 'avcu-disposable-' + role + '-only';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try { return await client.query(sql, params); }
  finally { await client.end(); }
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
    REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
    GRANT USAGE ON SCHEMA ${schema} TO ${roles.join(', ')};
    GRANT CREATE ON SCHEMA ${schema} TO avcu_test_migration;

    -- Exercise schema-scoped default ACLs: PUBLIC must not inherit table reads.
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO avcu_test_member;
    CREATE TABLE ${schema}.default_acl_probe(id integer primary key, payload text);

    CREATE TABLE ${schema}.column_acl_probe(id integer primary key, public_note text, secret_note text);
    GRANT SELECT (id, public_note) ON ${schema}.column_acl_probe TO avcu_test_support;
    GRANT SELECT (id, public_note, secret_note) ON ${schema}.column_acl_probe TO avcu_test_auditor;

    CREATE SEQUENCE ${schema}.worker_sequence;
    GRANT USAGE, SELECT ON SEQUENCE ${schema}.worker_sequence TO avcu_test_worker;

    CREATE FUNCTION ${schema}.worker_probe() RETURNS integer
      LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$ SELECT 42 $$;
    REVOKE ALL ON FUNCTION ${schema}.worker_probe() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${schema}.worker_probe() TO avcu_test_worker;

    CREATE TABLE ${schema}.owner_probe(id integer primary key);
    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;
  `);
});

after(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('PUBLIC and default ACLs do not grant unintended table access', async () => {
  const acl = await admin.query(`
    SELECT c.relname, x.grantee, x.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r',c.relowner))) x
    WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND x.grantee=0
  `, [schema]);
  assert.equal(acl.rows.length, 0, 'PUBLIC must have no table privileges in the isolated security schema');
  const member = await actor('avcu_test_member', `SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_read`, [`${schema}.default_acl_probe`]);
  assert.equal(member.rows[0].can_read, true, 'explicit schema default privilege should apply to future table');
  const support = await actor('avcu_test_support', `SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_read`, [`${schema}.default_acl_probe`]);
  assert.equal(support.rows[0].can_read, false);
});

test('column grants expose only approved columns, not the whole row', async () => {
  const allowed = await actor('avcu_test_support', `SELECT public_note FROM ${schema}.column_acl_probe`);
  assert.equal(allowed.rowCount, 0);
  await assert.rejects(actor('avcu_test_support', `SELECT secret_note FROM ${schema}.column_acl_probe`), /permission denied/i);
  await assert.rejects(actor('avcu_test_support', `SELECT * FROM ${schema}.column_acl_probe`), /permission denied/i);
  const auditor = await actor('avcu_test_auditor', `SELECT secret_note FROM ${schema}.column_acl_probe`);
  assert.equal(auditor.rowCount, 0);
});

test('sequence grants distinguish USAGE, SELECT and UPDATE capabilities', async () => {
  const worker = await actor('avcu_test_worker', `SELECT has_sequence_privilege(current_user,$1,'USAGE') u, has_sequence_privilege(current_user,$1,'SELECT') s, has_sequence_privilege(current_user,$1,'UPDATE') w`, [`${schema}.worker_sequence`]);
  assert.deepEqual(worker.rows[0], {u:true,s:true,w:false});
  const next = await actor('avcu_test_worker', `SELECT nextval('${schema}.worker_sequence') AS value`);
  assert.equal(Number(next.rows[0].value), 1);
  const member = await actor('avcu_test_member', `SELECT has_sequence_privilege(current_user,$1,'USAGE') u`, [`${schema}.worker_sequence`]);
  assert.equal(member.rows[0].u, false);
  await assert.rejects(actor('avcu_test_member', `SELECT nextval('${schema}.worker_sequence')`), /permission denied/i);
});

test('function EXECUTE is revoked from PUBLIC and limited to the worker identity', async () => {
  const acl = await admin.query(`
    SELECT x.grantee, x.privilege_type FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) x
    WHERE n.nspname=$1 AND p.proname='worker_probe'
  `, [schema]);
  assert.equal(acl.rows.some(x => x.grantee === 0 && x.privilege_type === 'EXECUTE'), false);
  const result = await actor('avcu_test_worker', `SELECT ${schema}.worker_probe() AS value`);
  assert.equal(result.rows[0].value, 42);
  await assert.rejects(actor('avcu_test_member', `SELECT ${schema}.worker_probe()`), /permission denied/i);
});

test('ownership and role membership do not leak DDL or escalation to runtime actors', async () => {
  const owner = await admin.query(`SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='owner_probe'`, [schema]);
  assert.equal(owner.rows[0].owner, (await admin.query('SELECT current_user')).rows[0].current_user);
  const membership = await admin.query(`
    SELECT count(*)::int AS n FROM pg_auth_members m
    JOIN pg_roles r ON r.oid=m.member
    JOIN pg_roles g ON g.oid=m.roleid
    WHERE r.rolname = ANY($1::text[]) AND g.rolname <> 'pg_read_all_data'
  `, [roles]);
  assert.equal(membership.rows[0].n, 0);
  await assert.rejects(actor('avcu_test_member', `ALTER TABLE ${schema}.owner_probe ADD COLUMN forbidden text`), /must be owner|permission denied/i);
  await assert.rejects(actor('avcu_test_support', 'SET ROLE avcu_test_admin'), /permission denied/i);
  const ddl = await actor('avcu_test_migration', `CREATE TABLE ${schema}.migration_owned_probe(id integer)`);
  assert.equal(ddl.command, 'CREATE');
  await assert.rejects(actor('avcu_test_worker', `CREATE TABLE ${schema}.worker_ddl_probe(id integer)`), /permission denied/i);
});

test('all role logins are non-superuser and cannot bypass RLS or create roles/databases', async () => {
  const result = await admin.query(`
    SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
    FROM pg_roles WHERE rolname=ANY($1::text[])
  `, [roles]);
  assert.equal(result.rows.length, roles.length);
  for (const row of result.rows) {
    assert.equal(row.rolsuper, false);
    assert.equal(row.rolbypassrls, false);
    assert.equal(row.rolcreatedb, false);
    assert.equal(row.rolcreaterole, false);
    assert.equal(row.rolcanlogin, true);
  }
});
