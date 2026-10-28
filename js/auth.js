import { api } from './api.js';
import { $, $$, setError, setBusy, toast } from './ui.js';

// Member authentication screen. The server owns the session; this module only
// toggles the sign-in / application panels.
export function initAuth({ onAuthenticated }) {
  const screen = $('#auth-screen');
  const loginForm = $('#login-form');
  const registerForm = $('#register-form');
  const success = $('#register-success');

  function showTab(tab) {
    const signin = tab === 'signin';
    loginForm.classList.toggle('hidden', !signin);
    registerForm.classList.toggle('hidden', signin);
    success.classList.add('hidden');
    $$('.auth-tab').forEach(button => {
      const active = button.dataset.authTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    (signin ? $('#login-identifier') : $('#register-name'))?.focus();
  }

  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-auth-tab]');
    if (tab && !screen.classList.contains('hidden')) {
      event.preventDefault();
      showTab(tab.dataset.authTab);
    }
  });

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = loginForm.querySelector('button[type="submit"]');
    const identifier = $('#login-identifier').value.trim();
    const password = $('#login-password').value;
    setError($('#login-error'), '');
    if (!identifier || !password) {
      setError($('#login-error'), 'Enter your credentials to continue.');
      return;
    }
    setBusy(button, true, 'Signing in…');
    try {
      const result = await api('/auth/login', { method: 'POST', body: { identifier, password } });
      loginForm.reset();
      await onAuthenticated(result.member);
    } catch (error) {
      setError($('#login-error'), error.message);
    } finally {
      setBusy(button, false);
    }
  });

  registerForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = registerForm.querySelector('button[type="submit"]');
    const payload = {
      fullName: $('#register-name').value.trim(),
      email: $('#register-email').value.trim(),
      username: $('#register-username').value.trim(),
      password: $('#register-password').value
    };
    setError($('#register-error'), '');
    if (!payload.fullName || !payload.email || !payload.username || !payload.password) {
      setError($('#register-error'), 'Complete every field to submit your application.');
      return;
    }
    setBusy(button, true, 'Submitting…');
    try {
      const result = await api('/auth/register', { method: 'POST', body: payload });
      registerForm.reset();
      registerForm.classList.add('hidden');
      success.classList.remove('hidden');
      $('#register-success-copy').textContent = result.message;
      $('#register-identity').innerHTML = `
        <div><dt>Member number</dt><dd>${result.member.memberNumber}</dd></div>
        <div><dt>Username</dt><dd>${result.member.username}</dd></div>
        <div><dt>Status</dt><dd>Pending verification</dd></div>`;
      toast('Membership application received.');
    } catch (error) {
      setError($('#register-error'), error.message);
    } finally {
      setBusy(button, false);
    }
  });

  return {
    show() {
      screen.classList.remove('hidden');
      $('#member-app').classList.add('hidden');
      $('#mobile-nav').classList.add('hidden');
      showTab('signin');
      $('#login-identifier')?.focus();
    },
    hide() {
      screen.classList.add('hidden');
    }
  };
}

export async function currentMember() {
  try {
    const result = await api('/auth/me');
    return result.member;
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

export async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* session already gone */ }
}
