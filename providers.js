/* Provider adapter contract.
 * Register only functions that call an authenticated, trusted backend.
 * Never place bank credentials, API secrets, or private keys in this browser file.
 */
(() => {
  'use strict';
  let adapter = null;
  const required = ['initiatePayment'];
  function register(candidate) {
    if (!candidate || typeof candidate !== 'object' || required.some(key => typeof candidate[key] !== 'function')) {
      throw new TypeError('A provider adapter must implement initiatePayment(request).');
    }
    adapter = candidate;
    return true;
  }
  function configured(capability) {
    if (!adapter) return false;
    return capability ? typeof adapter[capability] === 'function' : true;
  }
  async function invoke(method, payload) {
    if (!configured(method)) return { ok: false, code: 'PROVIDER_NOT_CONFIGURED', message: 'This provider is not connected.' };
    return adapter[method](payload);
  }
  window.AVCUProviders = Object.freeze({
    register,
    isConfigured: () => configured('initiatePayment'),
    supports: capability => configured(capability),
    initiatePayment: request => invoke('initiatePayment', request),
    lookupZelleRecipient: name => invoke('lookupZelleRecipient', { name }),
    getFxQuote: request => invoke('getFxQuote', request),
    submitCheckDeposit: request => invoke('submitCheckDeposit', request),
    freezeCard: request => invoke('freezeCard', request),
    getAccountBalances: request => invoke('getAccountBalances', request)
  });
})();