(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let member = null;
  let accounts = [];
  const dollars = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const showMessage = (id, message, error = false) => { const node = $(id); node.textContent = message || ''; node.classList.toggle('error', error); };
  async function api(path, options = {}) {
    const response = await fetch('/api' + path, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  function switchAuth(register) {
    $('login-form').classList.toggle('hidden', register);
    $('register-form').classList.toggle('hidden', !register);
    $('show-login').classList.toggle('active', !register);
    $('show-register').classList.toggle('active', register);
    showMessage('auth-message', '');
  }
  function setAuthenticated(value) {
    $('auth-panel').classList.toggle('hidden', value);
    $('dashboard').classList.toggle('hidden', !value);
  }
  async function loadDashboard() {
    const [accountData, transactionData, cardData, notificationData, tierData, loanData] = await Promise.all([
      api('/accounts'), api('/transactions?limit=30'), api('/card'), api('/notifications'), api('/membership-tier'), api('/loans/applications')
    ]);
    accounts = accountData.accounts || [];
    $('welcome-title').textContent = `Welcome, ${member?.fullName || 'member'}`;
    $('member-subtitle').textContent = `Member ID: ${member?.memberNumber || 'pending'} · ${member?.email || ''} · Status: ${member?.status || 'unknown'}`;
    $('total-balance').textContent = dollars(accounts.reduce((sum, a) => sum + Number(a.balanceCents || 0), 0));
    const tier = tierData.membership;
    $('membership-tier').textContent = tier?.label || 'New Member';
    $('tier-detail').textContent = `${tier?.activity90Days ?? 0} qualifying transactions in 90 days`;
    const card = cardData.card;
    $('card-status').textContent = card?.status || 'Not issued';
    $('card-last4').textContent = card ? `Sandbox card ending ${card.last4}` : 'Card appears after membership approval';
    $('freeze-button').disabled = !card;
    $('freeze-button').textContent = card?.status === 'frozen' ? 'Unfreeze card' : 'Freeze card';
    $('accounts-list').innerHTML = accounts.length ? accounts.map(a => `<article class="account-row"><span class="account-symbol">AV</span><span class="account-info"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.kind)} · •••• ${escapeHtml(a.suffix)}</small></span><strong>${dollars(a.balanceCents)}</strong></article>`).join('') : '<p class="muted">No open share accounts yet. Membership approval is required.</p>';
    for (const id of ['transfer-from','transfer-to','deposit-account']) {
      const select = $(id);
      const previous = select.value;
      select.innerHTML = accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · •••• ${escapeHtml(a.suffix)}</option>`).join('');
      if (accounts.some(a => a.id === previous)) select.value = previous;
    }
    $('transactions-list').innerHTML = transactionData.transactions?.length ? `<table><thead><tr><th>Date</th><th>Type / description</th><th>Status</th><th>Amount</th></tr></thead><tbody>${transactionData.transactions.map(t => `<tr><td>${escapeHtml(new Date(t.createdAt).toLocaleDateString())}</td><td><strong>${escapeHtml(t.memo || t.type)}</strong><small>${escapeHtml(t.reference)}</small></td><td><span class="status-pill">${escapeHtml(String(t.status).replaceAll('_',' '))}</span></td><td>${dollars(t.amountCents)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No API transactions yet.</p>';
    $('notifications-list').innerHTML = notificationData.notifications?.length ? notificationData.notifications.map(n => `<article class="notification-row ${n.read ? '' : 'unread'}"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.body)}</p><small>${escapeHtml(new Date(n.createdAt).toLocaleString())}</small></article>`).join('') : '<p class="muted">No notifications yet.</p>';
    $('loan-submit').disabled = member?.status !== 'verified';
    $('loan-form-note').textContent = member?.status === 'verified'
      ? 'Applications are reviewed by management. Approval does not disburse funds or guarantee a rate.'
      : 'Membership verification is required before applying for a loan.';
    const applications = loanData.applications || [];
    $('loan-applications-list').innerHTML = applications.length ? applications.map(app => \`<article class="notification-row">
      <strong>\${escapeHtml(app.reference)} · \${dollars(app.requestedAmountCents)}</strong>
      <p>Status: <span class="status-pill">\${escapeHtml(String(app.status).replaceAll('_',' '))}</span>\${app.requestedTermMonths ? \` · \${escapeHtml(app.requestedTermMonths)} months requested\` : ''}</p>
      <p>\${escapeHtml(app.purpose)}</p>
      \${app.decisionReason ? \`<p class="muted">Decision note: \${escapeHtml(app.decisionReason)}</p>\` : ''}
      <small>Submitted \${escapeHtml(new Date(app.submittedAt).toLocaleString())} · USD</small>
      \${app.status === 'information_required' ? \`<form class="loan-response-form stack top-gap" data-loan-id="\${escapeHtml(app.id)}"><label>Additional information requested</label><textarea name="response" minlength="10" maxlength="2000" rows="3" required></textarea><button class="secondary" type="submit">Send response</button></form>\` : ''}
    </article>\`).join('') : '<p class="muted">No loan applications yet.</p>';

  }
  async function refresh() {
    try { await loadDashboard(); showMessage('dashboard-message','Account information refreshed.'); }
    catch (error) { showMessage('dashboard-message',error.message,true); }
  }
  $('show-login').addEventListener('click', () => switchAuth(false));
  $('show-register').addEventListener('click', () => switchAuth(true));
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); showMessage('auth-message','Signing in…');
    try { const data = await post('/auth/login',{identifier:$('login-identifier').value,password:$('login-password').value}); member=data.member; setAuthenticated(true); await refresh(); }
    catch(error) { showMessage('auth-message',error.message,true); }
  });
  $('register-form').addEventListener('submit', async event => {
    event.preventDefault(); showMessage('auth-message','Submitting application…');
    try { const data = await post('/auth/register',{fullName:$('register-name').value,email:$('register-email').value,password:$('register-password').value}); switchAuth(false); $('login-identifier').value=$('register-email').value; const memberNumber = data.member?.memberNumber ? ` Your member number is ${data.member.memberNumber}; save it for future sign-in.` : ''; showMessage('auth-message',(data.message || 'Application received. You can sign in to track it.') + memberNumber); }
    catch(error) { showMessage('auth-message',error.message,true); }
  });
  $('logout-button').addEventListener('click', async () => {
    try { await post('/auth/logout',{}); } catch {}
    member=null; setAuthenticated(false); switchAuth(false);
  });
  $('refresh-button').addEventListener('click', refresh);
  $('transfer-form').addEventListener('submit', async event => {
    event.preventDefault();
    const amountCents = Math.round(Number($('transfer-amount').value) * 100);
    if ($('transfer-from').value === $('transfer-to').value) return showMessage('dashboard-message','Choose two different accounts.',true);
    try {
      const result = await api('/transfers',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({kind:'share',fromAccountId:$('transfer-from').value,toAccountId:$('transfer-to').value,amountCents,memo:$('transfer-memo').value})});
      showMessage('dashboard-message',result.message || 'Transfer submitted.'); await refresh();
    } catch(error) { showMessage('dashboard-message',error.message,true); }
  });
  $('deposit-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await api('/deposits',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({accountId:$('deposit-account').value,amountCents:Math.round(Number($('deposit-amount').value)*100),description:$('deposit-description').value})});
      showMessage('dashboard-message',result.message || 'Deposit submitted.'); await refresh();
    } catch(error) { showMessage('dashboard-message',error.message,true); }
  });
  $('freeze-button').addEventListener('click', async () => {
    try { const frozen = $('freeze-button').textContent.toLowerCase().includes('unfreeze'); await post('/card/freeze',{frozen:!frozen}); await refresh(); }
    catch(error) { showMessage('dashboard-message',error.message,true); }
  });
  $('purchase-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { const result = await post('/card/test-purchase',{merchant:$('purchase-merchant').value,amountCents:Math.round(Number($('purchase-amount').value)*100)}); showMessage('dashboard-message',result.message); }
    catch(error) { showMessage('dashboard-message',error.message,true); }
  });

  $('loan-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('loan-submit');
    button.disabled = true;
    try {
      const body = {
        requestedAmountCents: Math.round(Number($('loan-amount').value) * 100),
        currency: 'USD',
        requestedTermMonths: $('loan-term').value ? Number($('loan-term').value) : null,
        purpose: $('loan-purpose').value
      };
      const result = await post('/loans/applications', body);
      $('loan-form').reset();
      showMessage('dashboard-message', result.message || 'Loan application submitted for review.');
      await refresh();
    } catch (error) {
      showMessage('dashboard-message', error.message, true);
    } finally {
      button.disabled = member?.status !== 'verified';
    }
  });
  $('refresh-loans').addEventListener('click', refresh);
  $('loan-applications-list').addEventListener('submit', async event => {
    const form = event.target.closest('.loan-response-form');
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await post(\`/loans/applications/\${form.dataset.loanId}/information\`, {
        response: form.elements.response.value
      });
      showMessage('dashboard-message', 'Your additional information was submitted for review.');
      await refresh();
    } catch (error) {
      showMessage('dashboard-message', error.message, true);
      button.disabled = false;
    }
  });
  $('read-notifications').addEventListener('click', async () => {
    try { await post('/notifications/mark-read',{}); await refresh(); }
    catch(error) { showMessage('dashboard-message',error.message,true); }
  });
  (async () => {
    try { const data = await api('/auth/me'); member = data.member; setAuthenticated(true); await refresh(); }
    catch { setAuthenticated(false); }
  })();
})();
