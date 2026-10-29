(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const form = $('#auth-form');
const notice = $('#notice');
let mode = 'login';
let busy = false;
const identityBase = '/.netlify/identity';
function showNotice(message, kind = 'neutral') {
  notice.textContent = message;
  notice.className = 'notice ' + kind;
  notice.hidden = false;
}
function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const signup = mode === 'signup';
  $('#form-title').textContent = signup ? 'Create your account' : 'Welcome back';
  $('#form-description').textContent = signup ? 'Create secure sign-in credentials to begin onboarding.' : 'Sign in to continue to your member space.';
  $('#name-label').hidden = !signup;
  $('#full-name').hidden = !signup;
  $('#full-name').required = signup;
  $('#password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#password-help').hidden = !signup;
  $('#submit').innerHTML = signup ? 'Create account <span aria-hidden="true">→</span>' : 'Sign in securely <span aria-hidden="true">→</span>';
  $('#forgot').hidden = signup;
  notice.hidden = true;
}
async function api(path, body) {
  const response = await fetch(identityBase + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || 'We could not complete that request. Please try again.');
  return data;
}
function setBusy(value) {
  busy = value;
  $('#submit').disabled = value;
  $('#submit').textContent = value ? 'Please wait…' : (mode === 'signup' ? 'Create account →' : 'Sign in securely →');
}
function renderMember(user) {
  $('#auth-form').closest('.auth-card').hidden = true;
  document.querySelector('.hero-copy').hidden = true;
  $('#member-panel').hidden = false;
  $('#member-heading').textContent = 'Welcome to your member space';
  $('#member-copy').textContent = user.email || 'Signed-in member';
  $('#member-status').textContent = user.confirmed_at ? 'Email confirmed' : 'Email confirmation required';
  $('#member-status-copy').textContent = user.confirmed_at
    ? 'Your sign-in is active. Identity and membership approval are separate and remain pending until reviewed.'
    : 'Check your inbox for the confirmation link before continuing.';
}
async function loadSession() {
  const token = localStorage.getItem('avcu_identity_token');
  if (!token) return;
  try {
    const response = await fetch(identityBase + '/user', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!response.ok) { localStorage.removeItem('avcu_identity_token'); return; }
    const user = await response.json();
    renderMember(user);
  } catch {
    showNotice('We could not check your session. Please check your connection and sign in again.', 'error');
  }
}
async function handleHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = params.get('confirmation_token') || params.get('recovery_token') || params.get('invite_token') || params.get('email_change_token');
  const type = params.has('confirmation_token') ? 'signup' : params.has('recovery_token') ? 'recovery' : params.has('invite_token') ? 'invite' : params.has('email_change_token') ? 'email_change' : null;
  if (!token || !type) return;
  try {
    const data = await api('/verify', { token, type });
    history.replaceState(null, '', location.pathname + location.search);
    if (data.access_token) localStorage.setItem('avcu_identity_token', data.access_token);
    showNotice(type === 'signup' ? 'Email confirmed. You can now sign in and continue onboarding.' : 'The link was verified. Please continue securely.', 'success');
    if (data.user) renderMember(data.user);
  } catch (error) {
    showNotice(error.message + ' Request a fresh link if this one has expired.', 'error');
  }
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const email = $('#email').value.trim().toLowerCase();
  const password = $('#password').value;
  setBusy(true);
  try {
    if (mode === 'signup') {
      const fullName = $('#full-name').value.trim();
      await api('/signup', { email, password, data: { full_name: fullName } });
      showNotice('Account created. Check your email for a confirmation link. Account creation does not approve membership or identity.', 'success');
      setMode('login');
    } else {
      const data = await api('/token?grant_type=password', { email, password });
      if (!data.access_token) throw new Error('Sign-in did not return a valid session. Please try again.');
      localStorage.setItem('avcu_identity_token', data.access_token);
      renderMember(data.user || { email, confirmed_at: true });
    }
  } catch (error) {
    const text = String(error.message || '');
    if (text.includes('Failed to fetch') || text.includes('NetworkError')) {
      showNotice('Secure sign-in is not available yet. Netlify Identity must be enabled and configured for this site before members can register or sign in.', 'error');
    } else {
      showNotice(error.message, 'error');
    }
  } finally {
    setBusy(false);
  }
});
$('#forgot').addEventListener('click', async () => {
  const email = $('#email').value.trim().toLowerCase();
  if (!email) { showNotice('Enter your email address first, then request a password reset.', 'error'); $('#email').focus(); return; }
  try {
    await api('/recover', { email });
    showNotice('If an account exists for that email, a password recovery link will be sent.', 'success');
  } catch (error) { showNotice(error.message, 'error'); }
});
$('#signout').addEventListener('click', async () => {
  const token = localStorage.getItem('avcu_identity_token');
  try { if (token) await fetch(identityBase + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch {}
  localStorage.removeItem('avcu_identity_token');
  location.reload();
});
(async () => { await handleHash(); await loadSession(); })();
})();