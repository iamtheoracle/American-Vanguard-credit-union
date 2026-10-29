export const tierRequirements = Object.freeze({
  standard: { label: "Standard", next: "plus", requirements: [] },
  plus: { label: "Plus", next: "premier", requirements: [
    { key: "verified_profile", label: "Complete member verification", kind: "boolean", target: true },
    { key: "months_active", label: "Active membership", kind: "number", target: 3, unit: "months" },
    { key: "eligible_activity_count", label: "Eligible account activity", kind: "number", target: 5, unit: "transactions" }
  ] },
  premier: { label: "Premier", next: null, requirements: [
    { key: "verified_profile", label: "Complete member verification", kind: "boolean", target: true },
    { key: "months_active", label: "Active membership", kind: "number", target: 12, unit: "months" },
    { key: "eligible_activity_count", label: "Eligible account activity", kind: "number", target: 25, unit: "transactions" }
  ] }
});

export function getTierProgress(currentTier, memberFacts) {
  const tier = tierRequirements[currentTier];
  if (!tier) throw new TypeError("Unknown membership tier");
  if (!tier.next) return { currentTier: tier.label, nextTier: null, progressPercent: 100, requirements: [], qualified: true };
  const next = tierRequirements[tier.next];
  const requirements = next.requirements.map(rule => {
    const actual = memberFacts[rule.key];
    const met = rule.kind === "boolean" ? actual === rule.target :
      Number.isFinite(actual) && actual >= rule.target;
    const ratio = rule.kind === "boolean" ? (met ? 1 : 0) :
      (Number.isFinite(actual) && actual > 0 ? Math.min(actual / rule.target, 1) : 0);
    return { ...rule, actual: actual ?? (rule.kind === "boolean" ? false : 0), met, progressPercent: Math.round(ratio * 100) };
  });
  const progressPercent = Math.round(requirements.reduce((sum, item) => sum + item.progressPercent, 0) / requirements.length);
  return { currentTier: tier.label, nextTier: next.label, progressPercent, requirements, qualified: requirements.every(item => item.met) };
}
