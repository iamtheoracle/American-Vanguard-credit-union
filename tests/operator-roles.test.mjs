import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_ROLES, isOperatorRole, rolesForGuards } from '../server/operator-roles.js';

test('auditor is a defined least-privilege role', () => {
  assert.equal(isOperatorRole('auditor'), true);
  assert.deepEqual(OPERATOR_ROLES.auditor.capabilities, ['migrations:read', 'audit:read', 'teams:read']);
});

test('unknown and caller-invented roles are rejected', () => {
  assert.equal(isOperatorRole('owner'), false);
  assert.throws(() => rolesForGuards('owner'), /Unknown operator role group/);
});

test('auditor guard group does not include write-capable roles', () => {
  assert.deepEqual(rolesForGuards('auditor'), ['auditor']);
});
