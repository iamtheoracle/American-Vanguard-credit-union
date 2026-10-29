const transitions = {
  loan: {
    submitted: { under_review: ["operator", "management", "super_admin"] },
    under_review: {
      information_required: ["operator", "management", "super_admin"],
      recommended: ["operator"],
      approved: ["management", "super_admin"],
      rejected: ["management", "super_admin"]
    },
    information_required: { under_review: ["operator", "management", "super_admin"] },
    recommended: { approved: ["management", "super_admin"], rejected: ["management", "super_admin"] },
    approved: {},
    rejected: {},
    cancelled: {},
    disbursed: {}
  },
  money_request: {
    submitted: { under_review: ["operator", "management", "super_admin"] },
    under_review: {
      information_required: ["operator", "management", "super_admin"],
      approved: ["management", "super_admin"],
      rejected: ["management", "super_admin"]
    },
    information_required: { under_review: ["operator", "management", "super_admin"] },
    approved: {},
    rejected: {},
    cancelled: {},
    posted: {}
  }
};

export function authorizeTransition({ workflow, from, to, role }) {
  if (!Object.hasOwn(transitions, workflow)) return { allowed: false, reason: "unknown_workflow" };
  const permittedRoles = transitions[workflow][from]?.[to];
  if (!permittedRoles) return { allowed: false, reason: "invalid_transition" };
  if (!permittedRoles.includes(role)) return { allowed: false, reason: "role_not_permitted" };
  return { allowed: true, reason: "allowed" };
}

export function buildStatusNotification({ entityType, entityId, memberId, memberEmail, from, to }) {
  if (!["approved", "rejected"].includes(to)) return null;
  if (!memberId || !memberEmail || !entityId) throw new TypeError("Notification recipient and entity identifiers are required");
  const normalizedType = entityType === "loan" ? "loan" : "money_request";
  return {
    eventKey: `${normalizedType}:${entityId}:${from}:${to}`,
    recipientMemberId: memberId,
    recipientEmail: memberEmail,
    templateKey: `${normalizedType}_${to}`,
    payload: { entityType: normalizedType, entityId, status: to }
  };
}

export function buildLoanSubmittedAlert({ loanId, memberId, amountMinor, currency }) {
  if (!loanId || !memberId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("Valid loan submission fields are required");
  }
  return {
    eventKey: `loan:${loanId}:submitted`,
    templateKey: "loan_submitted_internal_alert",
    payload: { loanId, memberId, amountMinor, currency, event: "submitted" }
  };
}
