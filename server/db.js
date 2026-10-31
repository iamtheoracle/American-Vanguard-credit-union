import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
export const DATABASE_URL = process.env.DATABASE_URL || 'postgres://avcu:avcu@127.0.0.1:5432/avcu';
const requestContext = new AsyncLocalStorage();
let pool = null;
let fixturePool = null;
function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || DATABASE_URL, max: 10 });
  return pool;
}
export default { get pool() { return getPool(); } };

export function configureFixturePoolForTests(testPool) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test fixture pool injection is disabled outside NODE_ENV=test');
  if (!testPool || typeof testPool.connect !== 'function' || typeof testPool.query !== 'function') throw new TypeError('Invalid test fixture pool');
  fixturePool = testPool;
}
export function configurePoolForTests(testPool) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test pool injection is disabled outside NODE_ENV=test');
  if (!testPool || typeof testPool.connect !== 'function' || typeof testPool.query !== 'function') throw new TypeError('Invalid test pool');
  pool = testPool;
}
export function currentActor() { return requestContext.getStore()?.actor || null; }
export function query(text, params) {
  const store = requestContext.getStore();
  return store?.client ? store.client.query(text, params) :
    (process.env.NODE_ENV === 'test' && fixturePool ? fixturePool : getPool()).query(text, params);
}

// Bind only after the server has validated its HttpOnly cookie against the
// server-side session table. The transaction is held until the HTTP response
// finishes, so every route query uses the same connection and SET LOCAL claims.
export function bindActorContext(req, res, actor, next) {
  if (!actor || !['member','operator','system','worker'].includes(actor.type)) {
    return next(new TypeError('A trusted actor context is required'));
  }
  const parent = requestContext.getStore();
  if (parent?.client) {
    if (parent.actor.type !== actor.type || String(parent.actor.id) !== String(actor.id)) {
      return next(new Error('Cannot change actor identity inside an active request transaction'));
    }
    return next();
  }
  (async () => {
    const client = await getPool().connect();
    let settled = false;
    const finish = async commit => {
      if (settled) return;
      settled = true;
      try {
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      } catch (error) {
        if (commit) {
          try { await client.query('ROLLBACK'); } catch {}
        }
        throw error;
      } finally {
        client.release();
      }
    };
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.actor_type', $1, true), set_config('app.actor_id', $2, true), set_config('app.actor_role', $3, true)",
        [actor.type, actor.id == null ? '' : String(actor.id), actor.role || '']);
      requestContext.run({ actor: Object.freeze({ ...actor }), client, savepoint: 0 }, () => {
        // Commit before ending the HTTP response. A finish-event commit races
        // the next request: clients can receive the response and retry while
        // the prior transaction is still invisible to other connections.
        let endStarted = false;
        if (typeof res.end === 'function') {
          const originalEnd = res.end.bind(res);
          res.end = (...args) => {
            if (endStarted) return res;
            endStarted = true;
            void finish(true).then(
              () => originalEnd(...args),
              error => {
                console.error('[avcu] request transaction commit failed:', error.code || error.name);
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  originalEnd(JSON.stringify({ error: 'Request could not be committed. Please retry.' }));
                } else {
                  originalEnd();
                }
              }
            );
            return res;
          };
        } else {
          // Minimal response doubles used by unit tests do not implement end().
          res.once('finish', () => { void finish(true).catch(error =>
            console.error('[avcu] request transaction commit failed:', error.code || error.name)); });
        }
        res.once('close', () => {
          if (!res.writableFinished && !endStarted) void finish(false).catch(error =>
            console.error('[avcu] request rollback failed:', error.code || error.name));
        });
        next();
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      next(error);
    }
  })().catch(next);
}

export async function withTx(fn) {
  const store = requestContext.getStore();
  if (store?.client) {
    const savepoint = `avcu_sp_${++store.savepoint}`;
    await store.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(store.client);
      await store.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await store.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
  const txPool = process.env.NODE_ENV === 'test' && fixturePool ? fixturePool : getPool();
  const client = await txPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function migrate(log = () => {}) {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured explicitly in production.');
  }
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
  if (fixturePool && fixturePool !== pool) await fixturePool.end();
  pool = null;
  fixturePool = null;
}

export function audit(client, event) {
  const sql = `INSERT INTO audit_events (actor_type, actor_id, actor_role, action, entity_type, entity_id, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  const actor = currentActor();
  const params = [event.actorType || actor?.type || 'system', event.actorId || actor?.id || null,
    event.actorRole || actor?.role || null, event.action, event.entityType, event.entityId || null,
    JSON.stringify(event.metadata || {})];
  return client ? client.query(sql, params) : query(sql, params);
}
