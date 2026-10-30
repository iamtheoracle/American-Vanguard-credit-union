import {
  signup,
  login,
  logout,
  getUser,
  recoverPassword,
  handleAuthCallback
} from '@netlify/identity';

(() => {
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const form = $('#auth-form');
const notice = $('#notice');
let mode = 'login';
let busy = false;
let recoveryToken = null;
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
  const signupMode = mode === 'signup';
  const resetMode = mode === 'reset';
  $('#form-title').textContent = signupMode ? 'Start membership' : resetMode ? 'Choose a new password' : 'Member sign in';
  $('#form-description').textContent = signupMode ? 'Register with email and password, then confirm your email. Your membership application is reviewed separately.' : resetMode ? 'Set a new password for your account.' : 'Use the email address and password registered to your member profile.';
  $('#name-label').hidden = !signupMode;
  $('#full-name').hidden = !signupMode;
  $('#full-name').required = signupMode;
  $('#password-label').textContent = resetMode ? 'New password' : 'Password';
  $('#password').autocomplete = signupMode || resetMode ? 'new-password' : 'current-password';
  $('#password-help').hidden = !(signupMode || resetMode);
  $('#submit').textContent = signupMode ? 'Register for membership →' : resetMode ? 'Update password →' : 'Sign in →';
  $('#forgot').hidden = signupMode || resetMode;
  document.querySelectorAll('[data-mode]').forEach(button => button.hidden = resetMode);
  notice.hidden = true;
}
function setBusy(value) {
  busy = value;
  $('#submit').disabled = value;
  $('#submit').textContent = value ? 'Please wait…' : (mode === 'signup' ? 'Register for membership →' : mode === 'reset' ? 'Update password →' : 'Sign in →');
}
async function memberRequest(method = 'GET', body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/member', {
    method, headers, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Member onboarding is temporarily unavailable.');
  return data;
}
function setAuthenticatedView(user) {
  $('#welcome').hidden = true;
  $('#member-panel').hidden = false;
  $('.institution-strip').hidden = true;
  $('#admin-panel').hidden = true;
  $('.institution-strip').hidden = true;
  $('#member-heading').textContent = 'Member relationship';
  $('#member-copy').textContent = user.email || 'Signed-in member';
}
function statusCopy(status) {
  return ({
    pending: ['Membership application pending', 'Your application has been received and is waiting for operator review. It is not approved yet.'],
    approved: ['Membership application approved', 'The operator review is complete. No share account or balance is implied; authoritative ledger data is not connected.'],
    rejected: ['Application not approved', 'Your application was not approved. Review the operator note if available, or contact membership services.'],
    resubmission: ['Resubmission requested', 'Update your application statement and submit again for another operator review.']
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
    formEl.hidden = !['rejected', 'resubmission'].includes(app.application_status);
    if (app.application_status === 'pending') {
      $('#member-status-copy').textContent = 'Your request is recorded and waiting for an operator review. You cannot approve your own application.';
    }
  } catch (error) {
    formEl.hidden = true;
    showNotice(error.message + ' Check that the preview database migration has completed.', 'error', $('#member-notice'));
  }
}
async function probeAdminAccess() {
  try {
    const response = await fetch('/api/admin/reviews', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!response.ok) return;
    $('#admin-entry').hidden = false;
    const data = await response.json();
    renderReviews(data.reviews || []);
  } catch { /* staff entry stays hidden until the server confirms access */ }
}

let wirePermissions = {};
async function wireRequest(body) {
  const response = await fetch('/api/admin/wire-confirmations', {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Wire confirmation queue unavailable.');
  return data;
}
function renderWireCases(cases) {
  const list = $('#wire-case-list'); list.replaceChildren();
  if (!cases.length) { list.append(el('p','muted','No external wire cases.')); return; }
  for (const item of cases) {
    const card = el('article','review-card');
    card.append(el('h3','',item.beneficiary_name + ' · ' + item.destination_institution));
    card.append(el('p','review-meta',item.sender_name + ' · ' + item.purpose + ' · ' + item.amount + ' ' + item.currency));
    card.append(el('p','review-meta','External reference: ' + item.external_reference));
    card.append(el('span','status-pill','Status: ' + item.status.replaceAll('_',' ')));
    for (const ev of item.evidence || []) card.append(el('p','review-statement','Evidence: ' + ev.evidence_summary + ' (' + ev.evidence_reference + ')'));
    if (item.status === 'awaiting_evidence' && wirePermissions.submitEvidence) {
      const f=el('form','review-form'), ref=el('input'), summary=el('textarea'), note=el('textarea');
      ref.required=true; ref.placeholder='vault:private/evidence-reference';
      summary.required=true; summary.minLength=10; summary.placeholder='Evidence summary; do not enter account numbers';
      note.required=true; note.minLength=3; note.placeholder='Submission note';
      const b=el('button','primary','Submit evidence'); b.type='submit';
      f.append(el('label','','Private vault reference'),ref,el('label','','Evidence summary'),summary,el('label','','Note'),note,b);
      f.addEventListener('submit',async e=>{e.preventDefault();b.disabled=true;try{await wireRequest({action:'submit_evidence',caseId:item.id,evidenceReference:ref.value,evidenceSummary:summary.value,note:note.value});await loadWireQueue();}catch(err){showNotice(err.message,'error',$('#wire-notice'));b.disabled=false;}});
      card.append(f);
    }
    if (item.status === 'evidence_submitted' && wirePermissions.decide) {
      const f=el('form','review-form'), decision=el('select'), note=el('textarea');
      for(const pair of [['confirmed','Confirm receiving-bank credit'],['rejected','Reject evidence'],['escalated','Escalate']]) { const o=el('option','',pair[1]);o.value=pair[0];decision.append(o); }
      note.required=true;note.minLength=10;note.placeholder='Document independent verification and decision';
      const b=el('button','primary','Record review decision');b.type='submit';
      f.append(el('label','','Decision'),decision,el('label','','Review note'),note,b);
      f.addEventListener('submit',async e=>{e.preventDefault();b.disabled=true;try{await wireRequest({action:'decide',caseId:item.id,decision:decision.value,note:note.value});await loadWireQueue();}catch(err){showNotice(err.message,'error',$('#wire-notice'));b.disabled=false;}});
      card.append(f);
    }
    const history=el('details','history');history.append(el('summary','','Audit history ('+(item.history||[]).length+')'));
    for(const ev of item.history||[]) history.append(el('p','review-meta',ev.action+' · '+ev.actor_identity_user_id+' · '+ev.note+' · '+new Date(ev.created_at).toLocaleString()));
    card.append(history); list.append(card);
  }
}
async function loadWireQueue() {
  const data=await wireRequest(); wirePermissions=data.permissions||{};
  $('#wire-create-form').hidden=!wirePermissions.create;
  renderWireCases(data.cases||[]);
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
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  const response = await fetch('/api/admin/reviews', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not load review queue.');
  renderReviews(data.reviews || []);
}
async function handleHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const recovery = params.get('recovery_token');
  if (recovery) {
    recoveryToken = recovery;
    history.replaceState(null, '', location.pathname + location.search);
    setMode('reset');
    showNotice('Recovery link detected. Choose a new password below.', 'success');
    return true;
  }
  if (location.hash && /confirmation_token|invite_token|email_change_token|access_token/.test(location.hash)) {
    try {
      const result = await handleAuthCallback();
      if (result) {
        showNotice(result.type === 'confirmation' ? 'Email confirmed. Sign in to continue your membership application.' : 'Authentication link verified. Continue securely.', 'success');
      }
    } catch (error) {
      showNotice(error.message || 'This link could not be verified. Request a fresh link and try again.', 'error');
    }
  }
  return false;
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
      await signup(email, password, { full_name: $('#full-name').value.trim() });
      setMode('login');
      showNotice('Account created. Check your email for the confirmation link. Account creation does not approve membership.', 'success');
    } else if (mode === 'reset') {
      if (!recoveryToken) throw new Error('Your recovery link has expired. Request a new password recovery link.');
      await recoverPassword(recoveryToken, password);
      recoveryToken = null;
      await logout();
      $('#password').value = '';
      setMode('login');
      showNotice('Password updated. Sign in with your new password.', 'success');
    } else {
      const user = await login(email, password);
      setAuthenticatedView(user);
      await loadMemberStatus();
      await probeAdminAccess();
    }
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes('MissingIdentityError') || message.includes('Identity is not configured')) {
      showNotice('Authentication is not available yet. Netlify Identity must be enabled and configured for this site.', 'error');
    } else showNotice(message || 'We could not complete that request. Please try again.', 'error');
  } finally { setBusy(false); }
});
$('#forgot').addEventListener('click', async () => {
  const email = $('#email').value.trim().toLowerCase();
  if (!email) { showNotice('Enter your email address first, then request a password reset.', 'error'); $('#email').focus(); return; }
  try {
    await recoverPassword(email);
    showNotice('If an account exists for that email, a password recovery link will be sent.', 'success');
  } catch (error) { showNotice(error.message || 'Password recovery is unavailable right now.', 'error'); }
});
$('#application-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#application-submit'); submit.disabled = true;
  try {
    await memberRequest('POST', { fullName: $('#application-name').value.trim(), statement: $('#application-statement').value.trim() });
    showNotice('Membership application submitted. It is pending operator review; you are not yet an approved member.', 'success', $('#member-notice'));
    await loadMemberStatus();
  } catch (error) { showNotice(error.message, 'error', $('#member-notice')); }
  finally { submit.disabled = false; }
});
$('#signout').addEventListener('click', async () => {
  try { await logout(); } catch {}
  location.reload();
});
$('#open-admin').addEventListener('click', async () => {
  try {
    await refreshReviews();
    await loadWireQueue();
    $('#member-panel').hidden = true;
    $('#admin-panel').hidden = false;
    $('#admin-notice').hidden = true;
  } catch (error) { showNotice(error.message, 'error', $('#member-notice')); }
});
$('#back-member').addEventListener('click', () => { $('#admin-panel').hidden = true; $('#member-panel').hidden = false; });
$('#wire-create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const formEl=event.currentTarget, button=formEl.querySelector('button'); button.disabled=true;
  const values=Object.fromEntries(new FormData(formEl).entries());
  try { await wireRequest({action:'create',...values}); formEl.reset(); showNotice('Case registered. No payment was sent.','success',$('#wire-notice')); await loadWireQueue(); }
  catch(error) { showNotice(error.message,'error',$('#wire-notice')); }
  finally { button.disabled=false; }
});
(async () => {
  const recoveryHandled = await handleHash();
  if (recoveryHandled) return;
  try {
    const user = await getUser();
    if (!user) return;
    setAuthenticatedView(user);
    await loadMemberStatus();
    await probeAdminAccess();
  } catch (error) {
    showNotice('We could not restore your session. Please sign in again. ' + (error?.message || ''), 'error');
  }
})();
})();