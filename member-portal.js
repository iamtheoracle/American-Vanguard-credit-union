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
    const [accountData, notificationData, tierData] = await Promise.all([
      api('/accounts'), api('/notifications'), api('/membership-tier')
    ]);
    accounts = accountData.accounts || [];
    $('welcome-title').textContent = `Welcome, ${member?.fullName || 'member'}`;
    $('member-subtitle').textContent = `Member ID: ${member?.memberNumber || 'pending'} · ${member?.email || ''} · Status: ${member?.status || 'unknown'}`;
    $('total-balance').textContent = dollars(accounts.reduce((sum, a) => sum + Number(a.balanceCents || 0), 0));
    const tier = tierData.membership;
    $('membership-tier').textContent = tier?.label || 'New Member';
    const tierProgress = tierData.progress;
    $('tier-detail').textContent = tierData.membership?.tier === 'review_required'
      ? 'Verification required before tier progress can be earned.'
      : tierProgress?.nextTier
        ? `${tierProgress.percent}% toward ${tierProgress.nextTier} · ${tier?.activity90Days ?? 0} qualifying transactions in 90 days`
        : `${tier?.activity90Days ?? 0} qualifying transactions in 90 days · Highest activity tier`;
    $('tier-detail').setAttribute('title', [
      tierProgress?.note,
      ...(tierProgress?.requirements || []).map(item => `${item.label}: ${item.current}/${item.required}${item.remaining ? ` (${item.remaining} remaining)` : ' (complete)'}`)
    ].filter(Boolean).join(' | '));
    $('card-status').textContent = 'Not connected';
    $('card-last4').textContent = 'Card details unavailable';
    $('accounts-list').innerHTML = accounts.length ? accounts.map(a => `<article class="account-row"><span class="account-symbol">AV</span><span class="account-info"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.kind)} · •••• ${escapeHtml(a.suffix)}</small></span><strong>${dollars(a.balanceCents)}</strong></article>`).join('') : '<p class="muted">No open share accounts yet. Membership approval is required.</p>';
    for (const id of ['transfer-from','transfer-to']) {
      const select = $(id);
      const previous = select.value;
      select.innerHTML = accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · •••• ${escapeHtml(a.suffix)}</option>`).join('');
      if (accounts.some(a => a.id === previous)) select.value = previous;
    }
    await loadActivity();
    $('notifications-list').innerHTML = notificationData.notifications?.length ? notificationData.notifications.map(n => `<article class="notification-row ${n.read ? '' : 'unread'}"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.body)}</p><small>${escapeHtml(new Date(n.createdAt).toLocaleString())}</small></article>`).join('') : '<p class="muted">No notifications yet.</p>';
  }
  let activityOffset = 0;
  let activityHasMore = false;
  let activityRequest = 0;
  async function loadActivity() {
    const requestId = ++activityRequest;
    const params = new URLSearchParams({ limit: '30', offset: String(activityOffset) });
    const search = $('activity-search').value.trim();
    const type = $('activity-type').value;
    const status = $('activity-status').value;
    const from = $('activity-from').value;
    const to = $('activity-to').value;
    if (search) params.set('search', search);
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    $('transactions-list').innerHTML = '<p class="muted">Loading activity…</p>';
    $('activity-prev').disabled = true;
    $('activity-next').disabled = true;
    try {
      const data = await api('/transactions?' + params.toString());
      if (requestId !== activityRequest) return;
      const transactions = data.transactions || [];
      activityHasMore = Boolean(data.pagination?.hasMore);
      $('transactions-list').innerHTML = transactions.length ? `<table><thead><tr><th>Date &amp; time</th><th>Activity / reference</th><th>Status</th><th>Amount</th></tr></thead><tbody>${transactions.map(t => {
        const date = new Date(t.createdAt);
        const dateLabel = Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
        return `<tr><td>${escapeHtml(dateLabel)}</td><td><strong>${escapeHtml(t.memo || t.type)}</strong><small>${escapeHtml(t.reference || 'No reference')}</small></td><td><span class="status-pill">${escapeHtml(String(t.status || 'unknown').replaceAll('_',' '))}</span></td><td>${dollars(t.amountCents)}</td></tr>`;
      }).join('')}</tbody></table>` : '<p class="muted">No activity matches these filters. Try changing the search or date range.</p>';
      const first = transactions.length ? activityOffset + 1 : 0;
      const last = activityOffset + transactions.length;
      $('activity-page-label').textContent = transactions.length ? `Showing ${first}–${last} records${activityHasMore ? ' · More available' : ' · End of results'}` : 'No matching records';
      $('activity-prev').disabled = activityOffset === 0;
      $('activity-next').disabled = !activityHasMore;
      showMessage('activity-message', '');
    } catch (error) {
      if (requestId !== activityRequest) return;
      $('transactions-list').innerHTML = '<p class="muted">Activity could not be loaded. Please retry.</p>';
      $('activity-page-label').textContent = 'Activity unavailable';
      $('activity-prev').disabled = activityOffset === 0;
      $('activity-next').disabled = true;
      showMessage('activity-message', error.message, true);
    }
  }
  async function refresh() {
    try { await loadDashboard(); showMessage('dashboard-message','Account information refreshed.'); }
    catch (error) { showMessage('dashboard-message',error.message,true); }
  }
  const rememberedIdentifier = (() => { try { return localStorage.getItem('avcu.remembered-member-identifier') || ''; } catch { return ''; } })();
  $('login-identifier').value = rememberedIdentifier;
  $('remember-identifier').checked = Boolean(rememberedIdentifier);
  $('remember-identifier').addEventListener('change', () => {
    if (!$('remember-identifier').checked) {
      try { localStorage.removeItem('avcu.remembered-member-identifier'); } catch {}
    }
  });
  $('forgot-password').addEventListener('click', () => {
    showMessage('auth-message', 'Password recovery is not available yet. Contact the authorized system operator; do not share your password or verification codes.');
  });
  $('show-login').addEventListener('click', () => switchAuth(false));
  $('show-register').addEventListener('click', () => switchAuth(true));
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); showMessage('auth-message','Signing in…');
    try { const identifier = $('login-identifier').value.trim(); if ($('remember-identifier').checked) { try { localStorage.setItem('avcu.remembered-member-identifier', identifier); } catch {} } else { try { localStorage.removeItem('avcu.remembered-member-identifier'); } catch {} } const data = await post('/auth/login',{identifier,password:$('login-password').value}); member=data.member; setAuthenticated(true); await refresh(); }
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
  $('activity-filter-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('activity-from').value && $('activity-to').value && $('activity-from').value > $('activity-to').value) {
      showMessage('activity-message', 'The start date must be on or before the end date.', true);
      return;
    }
    activityOffset = 0;
    loadActivity();
  });
  $('activity-reset').addEventListener('click', () => {
    $('activity-search').value = '';
    $('activity-type').value = '';
    $('activity-status').value = '';
    $('activity-from').value = '';
    $('activity-to').value = '';
    activityOffset = 0;
    loadActivity();
  });
  $('activity-prev').addEventListener('click', () => {
    activityOffset = Math.max(0, activityOffset - 30);
    loadActivity();
  });
  $('activity-next').addEventListener('click', () => {
    if (activityHasMore) { activityOffset += 30; loadActivity(); }
  });

  $('transfer-form').addEventListener('submit', async event => {
    event.preventDefault();
    const amountCents = Math.round(Number($('transfer-amount').value) * 100);
    if ($('transfer-from').value === $('transfer-to').value) return showMessage('dashboard-message','Choose two different accounts.',true);
    try {
      const result = await api('/transfers',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({kind:'share',fromAccountId:$('transfer-from').value,toAccountId:$('transfer-to').value,amountCents,memo:$('transfer-memo').value})});
      showMessage('dashboard-message',result.message || 'Transfer submitted.'); await refresh();
    } catch(error) { showMessage('dashboard-message',error.message,true); }
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
