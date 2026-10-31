import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { close, audit } from './db.js';
import memberRoutes from './routes-member.js';
import operatorRoutes from './routes-operator.js';
import { verifyWebhookSignature, webhookSecret, integrationHealth } from './integrations/index.js';
import { query } from './db.js';
import { startNotificationWorker, stopNotificationWorker } from './notifications.js';
import { registerTeams, registerTeamServiceIdentities, listTeams } from './team-runtime.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Webhooks must receive the exact raw bytes for HMAC verification.
  // Register the raw-body route before the general JSON parser consumes the stream.
  app.use('/api/integrations/webhooks', express.raw({ type: '*/*', limit: '256kb' }), webhookHandler);

  app.use(express.json({ limit: '256kb' }));

  app.use('/api', memberRoutes);
  app.use('/api', operatorRoutes);

  app.get('/api/health', async (req, res) => {
    try {
      await query('SELECT 1');
      const integrations = await integrationHealth();
      const teams = await listTeams();
      res.json({ ok: true, service: 'avcu-api', time: new Date().toISOString(), integrations, teams });
    } catch (error) {
      res.status(500).json({ ok: false, error: 'Database unavailable' });
    }
  });

  // Static front end (existing AVCU experience + operator portal + login).
  app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'] }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(join(ROOT, 'index.html'));
    }
    next();
  });

  // Error handler: no stack traces to clients.
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[avcu] request error:', error.code || error.name, error.message, '\n', (error.stack || '').split('\n').slice(1, 4).join('\n'));
    res.status(500).json({ error: 'Something went wrong. Try again or contact support.' });
  });

  return app;
}

async function webhookHandler(req, res) {
  const provider = req.path.replace(/^\//, '').split('/')[0];
  if (!provider) return res.status(400).json({ error: 'Unknown provider' });
  const signature = req.header('X-AVCU-Signature');
  const timestamp = req.header('X-AVCU-Timestamp');
  const eventId = req.header('X-AVCU-Event-Id');
  const body = req.body instanceof Buffer ? req.body : Buffer.from('');
  const secret = webhookSecret(provider);
  if (!secret) {
    console.error('[avcu] webhook rejected: provider secret is not configured', provider);
    return res.status(503).json({ error: 'Webhook provider is not configured' });
  }
  const valid = verifyWebhookSignature({
    secret, body: body.toString('utf8'), signature, timestamp
  });
  if (!valid || !eventId) {
    console.warn('[avcu] webhook rejected: bad signature or missing event id', provider);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  try {
    // Replay protection: unique (provider, event_id).
    await query(
      `INSERT INTO webhook_events (provider, event_id, signature_valid, payload)
       VALUES ($1,$2,$3,$4)`,
      [provider, eventId, valid, body.toString('utf8').slice(0, 8000)]);
    return res.json({ received: true });
  } catch (error) {
    if (error.code === '23505') {
      return res.json({ received: true, replay: true });
    }
    throw error;
  }
}

export async function startServer({ port = process.env.PORT || 3000 } = {}) {
  // Schema migrations are executed only by the reviewed deployment pipeline.
  // Application startup must never perform DDL or advance schema state.
  await registerTeams();
  await registerTeamServiceIdentities();
  startNotificationWorker();
  const app = createApp();
  const server = app.listen(port, '0.0.0.0');
  await new Promise(resolve => server.once('listening', resolve));
  return server;
}

export async function shutdown(server) {
  await new Promise(resolve => server.close(resolve));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  stopNotificationWorker();
  await close();
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer().then(server => {
    console.log(`[avcu] API + static front end listening on port ${server.address().port}`);
    audit(null, { actorType: 'system', action: 'server.started', entityType: 'system', entityId: 'api' }).catch(() => {});
  }).catch(error => {
    console.error('[avcu] failed to start:', error.message);
    process.exit(1);
  });
}
