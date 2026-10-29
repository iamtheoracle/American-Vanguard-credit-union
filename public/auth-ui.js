(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { ready:false, user:null, roles:[], identityAvailable:false, inviteToken:null, recoveryToken:null, error:null };
  window.AVCUAuthState = state;
  const button = $('auth-button');
  const status = $('auth-status-text');
  const dialog = $('auth-dialog');
  const form = $('auth-form');
  const error = $('auth-error');
  const emailWrap = $('auth-email-wrap');
  const email = $('auth-email');
  const password = $('auth-password');
  const title = $('auth-title');
  const submit = $('auth-submit');
  const recovery = $('auth-recovery');

  function publish() {
    const roles = state.roles;
    button.textContent = state.user ? 'Sign out' : (state.inviteToken ? 'Set password' : 'Sign in');
    button.setAttribute('aria-label', state.user ? 'Sign out of shared services' : 'Sign in to shared services');
    if (state.user) {
      const role = roles.includes('admin') ? 'administrator' : roles.includes('operator') ? 'operator' : roles.includes('member') ? 'member' : 'no assigned role';
      status.textContent = 'Signed in · ' + role;
    } else {
      status.textContent = state.identityAvailable ? 'Local mode · not signed in' : 'Local mode · identity unavailable';
    }
    window.dispatchEvent(new CustomEvent('avcu:auth-state-updated', { detail:state }));
  }

  function showLogin() {
    error.textContent = '';
    if (state.inviteToken || state.recoveryToken) {
      emailWrap.classList.add('hidden');
      title.textContent = state.inviteToken ? 'Set your password' : 'Reset your password';
      submit.textContent = state.inviteToken ? 'Accept invitation' : 'Update password';
      password.autocomplete = 'new-password';
      if (recovery) recovery.classList.add('hidden');
    } else {
      if (recovery) recovery.classList.remove('hidden');
      emailWrap.classList.remove('hidden');
      title.textContent = 'Sign in to AVCU';
      submit.textContent = 'Sign in';
      password.autocomplete = 'current-password';
    }
    dialog.showModal();
  }

  button?.addEventListener('click', async () => {
    if (!state.user) return showLogin();
    try {
      await window.AVCUIdentity.logout();
      window.location.reload();
    } catch {
      status.textContent = 'Sign-out failed · retry';
    }
  });

  $('auth-cancel')?.addEventListener('click', () => dialog.close('cancel'));
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      if (state.inviteToken) {
        state.user = await window.AVCUIdentity.acceptInvite(state.inviteToken, password.value);
      } else if (state.recoveryToken) {
        state.user = await window.AVCUIdentity.recoverPassword(state.recoveryToken, password.value);
      } else {
        await window.AVCUIdentity.login(email.value.trim(), password.value);
      }
      window.location.reload();
    } catch {
      error.textContent = state.identityAvailable
        ? 'Sign-in failed. Check the account details or contact the AVCU administrator.'
        : 'Netlify Identity is not configured for this deployment. Local records remain on this device.';
    } finally {
      submit.disabled = false;
    }
  });

  recovery?.addEventListener('click', async () => {
    error.textContent = '';
    const address = email.value.trim();
    if (!address) { error.textContent = 'Enter your email address first.'; return; }
    try { await window.AVCUIdentity.requestPasswordRecovery(address); error.textContent = 'If this account exists, password recovery instructions have been sent.'; }
    catch { error.textContent = 'Password recovery is unavailable. Contact the administrator.'; }
  });

  async function initialize() {
    try {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      state.recoveryToken = hash.get('recovery_token') || null;
      const settings = await window.AVCUIdentity.getSettings();
      if (!settings) throw new Error('Identity is not enabled for this site');
      const callback = await window.AVCUIdentity.handleAuthCallback();
      state.identityAvailable = true;
      if (callback?.type === 'invite' && callback.token) {
        state.inviteToken = callback.token;
      } else if (callback?.type === 'recovery' && !state.recoveryToken) {
        state.error = 'This password recovery link is invalid or expired.';
      }
      state.user = await window.AVCUIdentity.getUser();
      state.roles = Array.isArray(state.user?.roles) ? state.user.roles : [];
    } catch (e) {
      state.identityAvailable = false;
      state.user = null;
      state.roles = [];
      state.error = e?.message || 'Identity unavailable';
    }
    state.ready = true;
    publish();
    if (state.inviteToken) showLogin();
    if (state.error && !state.inviteToken) status.title = state.error;
  }

  if (button && dialog && form && window.AVCUIdentity) initialize();
  else {
    state.ready = true;
    publish();
  }
})();
