(() => {
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const form = $('#auth-form');
const notice = $('#notice');
let mode = 'login';
let busy = false;
const identityBase = '/.netlify/identity';
const tokenKey = 'avcu_identity_token';
const token = () => sessionStorage.getItem(tokenKey);
function showNotice(message, kind = 'neutral', target = notice) {
  target.textContent = message;
  target.className = 'notice ' + kind;
  target.hidden = false;
}
function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const signup = mode === 'signup';
  const reset = mode === 'reset';
  $('#form-title').textContent = signup ? 'Create your account' : reset ? 'Choose a new password' : 'Welcome back';
  $('#form-description').textContent = signup ? 'Create secure sign-in credentials to begin onboarding.' : reset ? 'Set a new password for your account.' : 'Sign in to continue to your member space.';
  $('#name-label').hidden = !signup;
  $('#full-name').hidden = !signup;
  $('#full-name').required = signup;
  $('#password-label').textContent = reset ? 'New password' : 'Password';
  $('#password').autocomplete = signup || reset ? 'new-password' : 'current-password';
  $('#password-help').hidden = !(signup || reset);
  $('#submit').textContent = signup ? 'Create account →' : reset ? 'Update password →' : 'Sign in securely →';
  $('#forgot').hidden = signup || reset;
  document.querySelectorAll('[data-mode]').forEach(button => button.hidden = reset);
  notice.hidden = true;
}
async function api(path, body, method = 'POST', authToken = token()) {
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = 'Bearer ' + authToken;
  const response = await fetch(identityBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || 'We could not complete that request. Please try again.');
  return data;
}
function setBusy(value) {
  busy = value;
  $('#submit').disabled = value;
  $('#submit').textContent = value ? 'Please wait…' : (mode === 'signup' ? 'Create account →' : mode === 'reset' ? 'Update password →' : 'Sign in securely →');
}
function setAuthenticatedView(user) {
  $('#welcome').hidden = true;
  $('#member-panel').hidden = false;
  $('#admin-panel').hidden = true;
  $('#member-heading').textContent = 'Your member space';
  $('#member-copy').textContent = user.email || 'Signed-in member';
}
async function memberRequest(method = 'GET', body) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/member', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Member onboarding is temporarily unavailable.');
  return data;
}
function statusCopy(status) {
  return ({
    pending: ['Application pending review', 'Your application has been received. It is not approved yet.'],
    approved: ['Membership application approved', 'The verification workflow marked this application approved. This does not connect or create a banking account.'],
    rejected: ['Application not approved', 'Review the message from the credit union and contact support if you need clarification.'],
    resubmission: ['More information requested', 'Update your statement and submit again for another review.']
  })[status] || ['Application not submitted', 'Complete the application below to begin verification.'];
}
async function loadMemberStatus() {
  const formEl = $('#application-form');
  try {
    const data = await memberRequest();
    const app = data.application;
    if (!app) {
      $('#member-status').textContent = 'Application not submitted';
      $('#member-status-copy').textContent = 'Complete the application below to begin verification.';
      formEl.hidden = false;
      return;
    }
    const [heading, copy] = statusCopy(app.application_status);
    $('#member-status').textContent = heading;
    $('#member-status-copy').textContent = copy;
    $('#application-name').value = app.full_name || '';
    if (app.applicant_statement) $('#application-statement').value = app.applicant_statement;
    const canResubmit = ['rejected', 'resubmission'].includes(app.application_status);
    formEl.hidden = !canResubmit;
    if (app.application_status === 'pending') {
      $('#member-status-copy').textContent = 'Your request is securely recorded and waiting for staff review. You cannot approve yourself.';
    }
  } catch (error) {
    formEl.hidden = true;
    showNotice(error.message + ' Check that the preview database migration has completed.', 'error', $('#member-notice'));
  }
}
async function probeAdminAccess() {
  try {
    const response = await fetch('/api/admin/reviews', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token() } });
    if (response.status === 403 || response.status === 401) return;
    if (!response.ok) return;
    $('#admin-entry').hidden = false;
    const data = await response.json();
    renderReviews(data.reviews || []);
  } catch { /* staff entry stays hidden until the server confirms access */ }
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderReviews(reviews) {
  const list = $('#review-list');
  list.replaceChildren();
  if (!reviews.length) {
    list.append(el('p', 'muted', 'No membership verification requests have been submitted.'));
    return;
  }
  for (const item of reviews) {
    const card = el('article', 'review-card');
    const top = el('div', 'review-top');
    const details = el('div');
    details.append(el('h3', '', item.full_name || 'Applicant'));
    details.append(el('p', 'muted', item.email || 'Email unavailable'));
    details.append(el('p', 'review-statement', item.applicant_statement || 'No statement provided.'));
    top.append(details, el('span', 'status-pill status-' + String(item.verification_status || 'pending'), String(item.verification_status || 'pending').replace(/^[a-z]/, c => c.toUpperCase())));
    card.append(top);
    card.append(el('p', 'review-meta', 'Submitted: ' + (item.verification_created_at ? new Date(item.verification_created_at).toLocaleString() : 'Date unavailable')));
    const history = el('details', 'history');
    history.append(el('summary', '', 'Review history (' + (item.review_history || []).length + ')'));
    for (const event of item.review_history || []) {
      const row = el('div', 'history-item');
      row.append(el('strong', '', event.decision + ' · ' + new Date(event.created_at).toLocaleString()));
      row.append(el('p', '', event.note || 'No note'));
      history.append(row);
    }
    card.append(history);
    if (['pending', 'resubmission'].includes(item.verification_status)) {
      const reviewForm = el('form', 'review-form');
      const label = el('label', '', 'Decision');
      const select = el('select');
      select.required = true;
      for (const [value, labelText] of [['approved','Approve'],['rejected','Reject'],['resubmission','Request resubmission']]) {
        const option = el('option', '', labelText); option.value = value; select.append(option);
      }
      label.append(select);
      const noteLabel = el('label', '', 'Review note (required)');
      const note = el('textarea'); note.required = true; note.minLength = 3; note.maxLength = 2000; note.rows = 3; note.placeholder = 'Record the reason for this decision.';
      noteLabel.append(note);
      const submit = el('button', 'primary', 'Save decision');
      submit.type = 'submit';
      reviewForm.append(label, noteLabel, submit);
      reviewForm.addEventListener('submit', async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const response = await fetch('/api/admin/reviews', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token() },
            body: JSON.stringify({ verificationRequestId: item.verification_request_id, decision: select.value, note: note.value.trim() })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || 'Could not save this decision.');
          showNotice('Decision recorded in review history.', 'success', $('#admin-notice'));
          await refreshReviews();
        } catch (error) {
          showNotice(error.message, 'error', $('#admin-notice'));
          submit.disabled = false;
        }
      });
      card.append(reviewForm);
    } else {
      card.append(el('p', 'review-meta', 'This request has been decided. Previous review events remain in the audit history.'));
    }
    list.append(card);
  }
}
async function refreshReviews() {
  const response = await fetch('/api/admin/reviews', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token() } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not load review queue.');
  renderReviews(data.reviews || []);
}
async function handleHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const tokenParam = params.get('confirmation_token') || params.get('recovery_token') || params.get('invite_token') || params.get('email_change_token');
  const type = params.has('confirmation_token') ? 'signup' : params.has('recovery_token') ? 'recovery' : params.has('invite_token') ? 'invite' : params.has('email_change_token') ? 'email_change' : null;
  if (!tokenParam || !type) return;
  try {
    const data = await api('/verify', { token: tokenParam, type }, 'POST', null);
    history.replaceState(null, '', location.pathname + location.search);
    if (data.access_token) sessionStorage.setItem(tokenKey, data.access_token);
    if (type === 'recovery') {
      setMode('reset');
      showNotice('Recovery link verified. Choose a new password below.', 'success');
    } else {
      showNotice(type === 'signup' ? 'Email confirmed. Sign in to continue your membership application.' : 'The link was verified. Please continue securely.', 'success');
      setMode('login');
    }
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
      await api('/signup', { email, password, data: { full_name: $('#full-name').value.trim() } }, 'POST', null);
      showNotice('Account created. Check your email for the confirmation link. Account creation does not approve membership.', 'success');
      setMode('login');
    } else if (mode === 'reset') {
      const currentToken = token();
      if (!currentToken) throw new Error('Your recovery session has expired. Request a new password recovery link.');
      await api('/user', { password }, 'PUT', currentToken);
      sessionStorage.removeItem(tokenKey);
      $('#password').value = '';
      setMode('login');
      showNotice('Password updated. Sign in with your new password.', 'success');
    } else {
      const data = await api('/token?grant_type=password', { email, password }, 'POST', null);
      if (!data.access_token) throw new Error('Sign-in did not return a valid session. Please try again.');
      sessionStorage.setItem(tokenKey, data.access_token);
      setAuthenticatedView(data.user || { email });
      await loadMemberStatus();
      await probeAdminAccess();
    }
  } catch (error) {
    const message = String(error.message || '');
    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      showNotice('Authentication is not available yet. Netlify Identity must be enabled and configured for this site.', 'error');
    } else showNotice(error.message, 'error');
  } finally { setBusy(false); }
});
$('#forgot').addEventListener('click', async () => {
  const email = $('#email').value.trim().toLowerCase();
  if (!email) { showNotice('Enter your email address first, then request a password reset.', 'error'); $('#email').focus(); return; }
  try {
    await api('/recover', { email }, 'POST', null);
    showNotice('If an account exists for that email, a password recovery link will be sent.', 'success');
  } catch (error) { showNotice(error.message, 'error'); }
});
$('#application-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#application-submit'); submit.disabled = true;
  try {
    await memberRequest('POST', { fullName: $('#application-name').value.trim(), statement: $('#application-statement').value.trim() });
    showNotice('Application submitted. It is pending review; you are not verified yet.', 'success', $('#member-notice'));
    await loadMemberStatus();
  } catch (error) { showNotice(error.message, 'error', $('#member-notice')); }
  finally { submit.disabled = false; }
});
$('#signout').addEventListener('click', async () => {
  const currentToken = token();
  try { if (currentToken) await api('/logout', {}, 'POST', currentToken); } catch {}
  sessionStorage.removeItem(tokenKey);
  location.reload();
});
$('#open-admin').addEventListener('click', async () => {
  try {
    await refreshReviews();
    $('#member-panel').hidden = true;
    $('#admin-panel').hidden = false;
    $('#admin-notice').hidden = true;
  } catch (error) { showNotice(error.message, 'error', $('#member-notice')); }
});
$('#back-member').addEventListener('click', () => { $('#admin-panel').hidden = true; $('#member-panel').hidden = false; });
(async () => {
  await handleHash();
  const currentToken = token();
  if (!currentToken) return;
  try {
    const response = await fetch(identityBase + '/user', { headers: { Authorization: 'Bearer ' + currentToken, Accept: 'application/json' } });
    if (!response.ok) { sessionStorage.removeItem(tokenKey); return; }
    const user = await response.json();
    setAuthenticatedView(user);
    await loadMemberStatus();
    await probeAdminAccess();
  } catch {
    showNotice('We could not check your session. Please check your connection and sign in again.', 'error');
  }
})();
})();