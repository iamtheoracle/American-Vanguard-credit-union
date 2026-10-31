import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { startServer, shutdown } from '../../server/index.js';
import { migrate, close as closeDatabasePool } from '../../server/db.js';
import { seed, MEMBER_PASSWORD, OPERATOR_PASSWORD } from '../../server/seed.js';

const ADMIN_URL = process.env.AVCU_TEST_ADMIN_URL || 'postgres://avcu:avcu@127.0.0.1:5432/avcu';
const RUNTIME_URL = process.env.AVCU_TEST_RUNTIME_URL || ADMIN_URL;

export { MEMBER_PASSWORD, OPERATOR_PASSWORD };

export async function startTestServer({ aiProvider, sandboxFail } = {}) {
  const dbName = `avcu_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const previous = { ...process.env };
  const adminDbUrl = new URL(ADMIN_URL);
  adminDbUrl.pathname = `/${dbName}`;
  const runtimeDbUrl = new URL(RUNTIME_URL);
  runtimeDbUrl.pathname = `/${dbName}`;
  process.env.DATABASE_URL = adminDbUrl.toString();
  if (aiProvider) process.env.AVCU_AI_PROVIDER = aiProvider; else delete process.env.AVCU_AI_PROVIDER;
  if (sandboxFail) process.env.AVCU_SANDBOX_FAIL = sandboxFail; else delete process.env.AVCU_SANDBOX_FAIL;

  // Migrations use the isolated database owner. HTTP requests use a separate
  // non-owner login with no schema DDL privileges.
  await migrate();
  await closeDatabasePool();
  const provision = new pg.Client({ connectionString: ADMIN_URL });
  await provision.connect();
  await provision.query(`GRANT CONNECT ON DATABASE ${dbName} TO avcu_app_runtime`);
  await provision.query(`GRANT USAGE ON SCHEMA public TO avcu_app_runtime`);
  await provision.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avcu_app_runtime`);
  await provision.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO avcu_app_runtime`);
  await provision.query(`REVOKE CREATE ON SCHEMA public FROM avcu_app_runtime`);
  await provision.end();
  process.env.DATABASE_URL = runtimeDbUrl.toString();
  const identityCheck = new pg.Client({ connectionString: runtimeDbUrl.toString() });
  await identityCheck.connect();
  const identity = await identityCheck.query(`
    SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
           has_schema_privilege(current_user,'public','CREATE') AS can_create
    FROM pg_roles r WHERE r.rolname = session_user
  `);
  await identityCheck.end();
  if (identity.rowCount !== 1 || identity.rows[0].rolsuper ||
      identity.rows[0].rolbypassrls || identity.rows[0].rolcreatedb ||
      identity.rows[0].rolcreaterole || identity.rows[0].can_create) {
    throw new Error('Application journey database identity is not least-privilege');
  }
  const server = await startServer({ port: 0 });
  await seed({ log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    close: async () => {
      await shutdown(server);
      await closeDatabasePool();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      const admin2 = new pg.Client({ connectionString: ADMIN_URL });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin2.end();
    }
  };
}

export async function api(base, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  let data = null;
  const text = await response.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

export function setCookieFrom(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

export async function loginMember(base, email = 'jordan@avcu.demo', password = MEMBER_PASSWORD) {
  const r = await api(base, '/api/auth/login', { method: 'POST', body: { email, password } });
  return { response: r, cookie: setCookieFrom(r) };
}

export async function loginOperator(base, email = 'manager@avcu.demo') {
  const r = await api(base, '/api/operator/login', { method: 'POST', body: { email, password: OPERATOR_PASSWORD } });
  return { response: r, cookie: setCookieFrom(r) };
}

export async function getAccounts(base, cookie) {
  const r = await api(base, '/api/accounts', { cookie });
  if (r.status !== 200) throw new Error(`accounts failed: ${r.status}`);
  return r.data.accounts;
}
