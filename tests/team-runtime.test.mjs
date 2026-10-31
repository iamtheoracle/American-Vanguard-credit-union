import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertOperator, TEAM_DEFINITIONS } from '../server/team-runtime.js';

test('team registry defines independent bounded responsibilities', () => {
  assert.ok(TEAM_DEFINITIONS.length >= 8);
  assert.equal(new Set(TEAM_DEFINITIONS.map(t => t.id)).size, TEAM_DEFINITIONS.length);
  assert.ok(TEAM_DEFINITIONS.every(t => Array.isArray(t.capabilities) && t.capabilities.length));
});

test('runtime transitions reject unsafe lifecycle jumps', () => {
  assert.equal(canTransition('PROVISIONING','READY'), true);
  assert.equal(canTransition('ACTIVE','QUARANTINED'), true);
  assert.equal(canTransition('DISABLED','ACTIVE'), false);
  assert.equal(canTransition('QUARANTINED','ACTIVE'), false);
  assert.equal(canTransition('FAILED','PROVISIONING'), true);
});

test('operator controls fail closed for missing and low-privilege actors', () => {
  assert.throws(() => assertOperator(null), { status: 403 });
  assert.throws(() => assertOperator({type:'operator',role:'member'}), { status: 403 });
  assert.doesNotThrow(() => assertOperator({type:'operator',role:'super_admin'}));
});
