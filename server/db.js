import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export const DATABASE_URL = process.env.DATABASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'postgres://avcu:avcu@127.0.0.1:5432/avcu');

let pool = null;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required when NODE_ENV=production');
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}
export default { get pool() { return getPool(); } };
export const query = (text, params) => getPool().query(text, params);

export async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection already lost */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(log = () => {}) {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await withTx(async client => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    log(`applied migration ${file}`);
  }
}

export async function close() {
  if (pool) await pool.end();
  pool = null;
}

// ---- audit ----------------------------------------------------------------
export function audit(client, event) {
  const sql = `INSERT INTO audit_events (actor_type, actor_id, actor_role, action, entity_type, entity_id, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  const params = [event.actorType, event.actorId || null, event.actorRole || null,
    event.action, event.entityType, event.entityId || null,
    JSON.stringify(event.metadata || {})];
  return client ? client.query(sql, params) : query(sql, params);
}
