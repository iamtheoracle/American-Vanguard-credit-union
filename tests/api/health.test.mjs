import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.mjs';

let app;
before(async () => { app = await startTestServer(); });
after(async () => { if (app) await app.close(); });

test('liveness is process-only and returns success independently of dependency status', async () => {
  const result = await api(app.base, '/api/health/live');
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.service, 'avcu-api');
});

test('readiness endpoint reports dependency state separately', async () => {
  const result = await api(app.base, '/api/health/ready');
  assert.ok([200, 503].includes(result.status));
  assert.equal(typeof result.data.ok, 'boolean');
  assert.equal(result.data.service, 'avcu-api');
});
