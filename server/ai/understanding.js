const ACTION_VERBS = /\b(send|transfer|move|pay|withdraw|deposit|freeze|block|cancel|dispute|report|change|update|close|open)\b/i;
const URGENCY = /\b(urgent|emergency|right now|immediately|stolen|fraud|scam|locked out|can't access)\b/i;
const DISTRESS = /\b(scared|worried|frustrated|angry|confused|overwhelmed|panicking|upset|stressed)\b/i;
const NEGATION = /\b(don't|do not|never|not|stop|cancel)\b/i;
const FINANCIAL = /\b(balance|account|card|money|payment|deposit|transfer|loan|transaction|wire|ach)\b/i;

function hasMissingTarget(text) {
  return /\b(transfer|send|pay|move)\b/i.test(text) &&
    !/\b(to|into|from)\s+[a-z0-9]/i.test(text);
}

/**
 * Deterministic observable-signal analysis, not a claim to read emotions.
 * Scores intent clarity, required detail, risk, urgency, and clarification need.
 */
export function understandMessage(input) {
  const text = String(input || '').trim().slice(0, 4000);
  if (!text) return { intent: 'unknown', confidence: 0, risk: 'unknown', urgency: false, clarificationRequired: true,
    clarificationQuestion: 'What would you like help with?' };
  const action = ACTION_VERBS.test(text);
  const financial = FINANCIAL.test(text);
  const urgent = URGENCY.test(text);
  const distressSignal = DISTRESS.test(text);
  const negated = NEGATION.test(text);
  const missingTarget = hasMissingTarget(text);
  const intent = /\b(fraud|scam|stolen|unauthorized|dispute)\b/i.test(text) ? 'fraud_or_dispute'
    : /\b(balance|how much do i have)\b/i.test(text) ? 'account_information'
    : /\b(transfer|send|move)\b/i.test(text) ? 'transfer_request'
    : /\b(freeze|block)\b/i.test(text) ? 'card_control'
    : /\b(human|person|representative|agent)\b/i.test(text) ? 'human_handoff'
    : financial ? 'banking_support' : 'general_support';
  let confidence = 0.52 + (action ? 0.12 : 0) + (financial ? 0.12 : 0) + (text.split(/\s+/).length >= 4 ? 0.08 : 0);
  if (missingTarget) confidence -= 0.18;
  if (negated) confidence -= 0.12;
  confidence = Math.max(0.1, Math.min(0.95, confidence));
  const risk = /\b(transfer|send|move|pay|withdraw|wire|ach|close account|change phone)\b/i.test(text)
    ? 'high' : /\b(balance|account|card|fraud|dispute)\b/i.test(text) ? 'medium' : 'low';
  const clarificationRequired = (action && missingTarget) || (negated && action) || confidence < 0.58;
  const clarificationQuestion = missingTarget
    ? 'Which account should this come from, and where should it go?'
    : negated && action ? 'Just to confirm, are you asking me not to proceed with that action?'
    : confidence < 0.62 ? 'I want to make sure I understand. Could you explain what you need in a little more detail?' : null;
  return {
    intent, confidence: Number(confidence.toFixed(2)), risk, urgency: urgent,
    distressSignal, negated, financialContext: financial,
    clarificationRequired, clarificationQuestion,
    recommendedMode: risk === 'high' ? 'clarify_then_authenticated_workflow'
      : urgent ? 'prioritize_human_support' : 'conversational_assistance',
    explanation: 'Scores are based on observable language signals and must be calibrated against human-labelled evaluations.'
  };
}

/** Score understanding against a human-labelled expected interpretation. */
export function scoreUnderstanding({ actual, expected, userCorrection = false, safe = true, completed = false }) {
  const intentMatch = actual?.intent === expected?.intent ? 1 : 0;
  const riskMatch = actual?.risk === expected?.risk ? 1 : 0;
  const clarificationMatch = Boolean(actual?.clarificationRequired) === Boolean(expected?.clarificationRequired) ? 1 : 0;
  const safety = safe ? 1 : 0;
  const taskOutcome = completed ? 1 : 0;
  const correctionPenalty = userCorrection ? 1 : 0;
  const score = 0.30 * intentMatch + 0.15 * riskMatch + 0.15 * clarificationMatch + 0.25 * safety + 0.15 * taskOutcome - 0.15 * correctionPenalty;
  return {
    score: Number(Math.max(0, Math.min(1, score)).toFixed(3)),
    dimensions: { intentMatch, riskMatch, clarificationMatch, safety, taskOutcome, userCorrection: correctionPenalty }
  };
}
