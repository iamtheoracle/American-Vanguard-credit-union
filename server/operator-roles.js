// Canonical server-side operator role model. Never derive this from request input.
export const OPERATOR_ROLES = Object.freeze({
  operator: Object.freeze({ label: 'Operator', capabilities: Object.freeze(['support:assigned:read', 'support:assigned:write', 'queue:read']) }),
  management: Object.freeze({ label: 'Management', capabilities: Object.freeze(['support:scope:read', 'support:scope:write', 'approvals:review', 'migrations:read', 'audit:read', 'teams:read', 'queue:read']) }),
  auditor: Object.freeze({ label: 'Auditor', capabilities: Object.freeze(['migrations:read', 'audit:read', 'teams:read']) }),
  super_admin: Object.freeze({ label: 'Super administrator', capabilities: Object.freeze(['operators:manage', 'teams:control', 'security:admin', 'audit:read', 'approvals:review', 'support:scope:read', 'support:scope:write', 'migrations:read', 'queue:read']) })
});

export const OPERATOR_ROLE_NAMES = Object.freeze(Object.keys(OPERATOR_ROLES));

export function isOperatorRole(role) {
  return Object.hasOwn(OPERATOR_ROLES, role);
}

export function rolesForGuards(...groups) {
  const groupsByName = {
    operator: ['operator'],
    management: ['management', 'super_admin'],
    auditor: ['auditor'],
    super_admin: ['super_admin']
  };
  return groups.flatMap(group => {
    const roles = groupsByName[group];
    if (!roles) throw new Error(`Unknown operator role group: ${group}`);
    return roles;
  });
}
