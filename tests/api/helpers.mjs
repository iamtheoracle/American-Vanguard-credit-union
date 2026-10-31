import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { startServer, shutdown } from '../../server/index.js';
import { migrate } from '../../server/db.js';
import { seed, MEMBER_PASSWORD, OPERATOR_PASSWORD } from '../../server/seed.js';

const ADMIN_URL = process.env.AVCU_TEST_ADMIN_URL || 'postgres://avcu:avcu@127.0.0.1:5432/avcu';

export { MEMBER_PASSWORD, OPERATOR_PASSWORD };

export async function startTestServer({ aiProvider, sandboxFail } = {}) {
  const dbName = `avcu_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const previous = { ...process.env };
  process.env.DATABASE_URL = `${ADMIN_URL.replace(/\/[^/]+$/, '')}/${dbName}`;
  if (aiProvider) process.env.AVCU_AI_PROVIDER = aiProvider; else delete process.env.AVCU_AI_PROVIDER;
  if (sandboxFail) process.env.AVCU_SANDBOX_FAIL = sandboxFail; else delete process.env.AVCU_SANDBOX_FAIL;

  // Tests explicitly provision their isolated database; production app startup never runs DDL.
  await migrate();
  const server = await startServer({ port: 0 });
  await seed({ log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    close: async () => {
      await shutdown(server);
      for (const [k, v] of Object.entries(previous)) process.env[k] = v;
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
