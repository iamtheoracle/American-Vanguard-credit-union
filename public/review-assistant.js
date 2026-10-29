/* Review-assistance contract.
 * Local checks run without a network. A registered assistant may call a trusted backend,
 * but its output is advisory: only an authorized operator can approve or reject.
 */
(() => {
  'use strict';
  let remoteAssistant = null;
  function assessLocally(request, history) {
    const flags = [];
    if (request.amountCents >= 1000000) flags.push('High-value request: apply enhanced review policy.');
    if (['wire-transfer','zelle','fx','withdrawal','ira','401k','card-authorization'].includes(request.type)) flags.push('External or regulated movement: verify recipient, ownership, and authority.');
    if (request.type === 'check-deposit') flags.push('Check images and endorsement require manual verification before posting.');
    if (request.type === 'ira' || request.type === '401k') flags.push('Retirement request: verify plan eligibility, tax treatment, and provider rules.');
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const duplicate = (history || []).some(item => item.id !== request.id &&
      item.createdAt && Date.parse(item.createdAt) >= since &&
      item.type === request.type && item.amountCents === request.amountCents &&
      String(item.recipient || '').toLowerCase() === String(request.recipient || '').toLowerCase());
    if (duplicate) flags.push('Potential duplicate request in the last 24 hours.');
    if (!flags.length) flags.push('No local rule flags detected. This is not a fraud or compliance clearance.');
    return { mode: 'local-rules', flags, reviewedAt: new Date().toISOString(), advisoryOnly: true };
  }
  function register(candidate) {
    if (!candidate || typeof candidate.assess !== 'function') throw new TypeError('Review assistant must expose assess(request, history).');
    remoteAssistant = candidate;
  }
  async function assess(request, history) {
    const local = assessLocally(request, history);
    if (!remoteAssistant) return local;
    try {
      const result = await remoteAssistant.assess(request, history);
      return { ...local, ...(result || {}), mode: 'connected-assistant', advisoryOnly: true };
    } catch {
      return { ...local, mode: 'local-rules-fallback' };
    }
  }
  window.AVCUReviewAssistant = Object.freeze({ register, assessLocally, assess });
})();