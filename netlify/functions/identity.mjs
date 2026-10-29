function emailSet(value) {
  return new Set(String(value || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
}

export function rolesForSignup(email, existingRoles = [], operatorEmails = '', adminEmails = '') {
  const address = String(email || '').trim().toLowerCase();
  if (emailSet(adminEmails).has(address)) return ['member','operator','admin'];
  if (emailSet(operatorEmails).has(address)) return ['member','operator'];
  return Array.isArray(existingRoles) && existingRoles.length ? existingRoles : ['member'];
}

export default {
  userSignup(event) {
    const metadata = event.user.appMetadata || {};
    const roles = rolesForSignup(
      event.user.email,
      metadata.roles,
      process.env.AVCU_OPERATOR_EMAILS,
      process.env.AVCU_ADMIN_EMAILS
    );
    // Role changes are carried in the JWT and take effect on next login or token refresh.
    return {
      user: {
        ...event.user,
        appMetadata: { ...metadata, roles }
      }
    };
  }
};
