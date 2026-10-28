import { api } from './api.js';
import { initAuth, currentMember, signOut } from './auth.js';
import { initAssistant } from './chat.js';
import {
  $, $$, money, dollarsToCents, escapeHtml, shortDate, fullDateTime, statusLabel,
  statusTone, badge, initials, toast, announce, setError, setBusy, confirmAction
} from './ui.js';

const VIEW_META = {
  overview: ['MEMBER OVERVIEW', 'Overview'],
  accounts: ['ACCOUNTS', 'Accounts'],
  move: ['MOVE MONEY', 'Move money'],
  deposit: ['DEPOSIT', 'Deposit'],
  requests: ['MONEY REQUESTS', 'Requests'],
  activity: ['ACTIVITY', 'Activity'],
  card: ['CARD CONTROLS', 'Debit card'],
  rewards: ['REWARDS', 'Rewards'],
  invest: ['CERTIFICATES', 'Certificates'],
  loans: ['LENDING', 'Loans'],
  support: ['SUPPORT', 'Support'],
  security: ['SECURITY', 'Security']
};

const state = {
  member: null,
  accounts: [],
  card: null,
  notifications: [],
  view: 'overview',
  cases: [],
  activeCaseId: null,
  assistant: null
};

const auth = initAuth({ onAuthenticated: member => startApp(member) });

// ---------------------------------------------------------------- bootstrapping
async function boot() {
  $('#today-label').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  }).toUpperCase();
  bindGlobalEvents();
  try {
    const member = await currentMember();
    if (member) await startApp(member);
    else auth.show();
  } catch (error) {
    toast(error.message || 'Could not reach the server.', 'error');
    auth.show();
  }
}

async function startApp(member) {
  state.member = member;
  auth.hide();
  $('#member-app').classList.remove('hidden');
  $('#mobile-nav').classList.remove('hidden');
  renderIdentity();
  await Promise.all([loadAccounts(), loadNotifications()]);
  state.card = await api('/card').then(result => result.card).catch(() => null);
  state.assistant = state.assistant || initAssistant({
    onOpenSupport: () => { setView('support'); }
  });
  await setView('overview', { force: true });
  if (member.status === 'pending') {
    const banner = $('#pending-banner');
    banner.classList.remove('hidden');
    banner.innerHTML = `<strong>Verification in review.</strong> Your member number is ${escapeHtml(member.memberNumber)}. Accounts open after an operator approves your application.`;
  }
}

function renderIdentity() {
  const member = state.member;
  if (!member) return;
  $('#member-name').textContent = member.fullName;
  $('#member-number').textContent = `Member ${member.memberNumber}`;
  $('#member-avatar').textContent = initials(member.fullName);
  $('#sign-out-button').textContent = initials(member.fullName);
  $('#overview-card-holder').textContent = String(member.fullName || '').toUpperCase();
}

// ---------------------------------------------------------------- data loading
async function loadAccounts() {
  const result = await api('/accounts');
  state.accounts = result.accounts || [];
  populateAccountSelects();
  return state.accounts;
}

async function loadNotifications() {
  const result = await api('/notifications');
  state.notifications = result.notifications || [];
  renderNotifications();
}

function populateAccountSelects() {
  const options = state.accounts.map(account =>
    `<option value="${account.id}">${escapeHtml(account.name)} · ••${escapeHtml(account.suffix)} · ${money(account.balanceCents)}</option>`
  ).join('');
  for (const id of ['transfer-from', 'transfer-to', 'deposit-account', 'rewards-account', 'invest-account', 'loan-account']) {
    const select = $(`#${id}`);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = options;
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  const from = $('#transfer-from');
  const to = $('#transfer-to');
  if (from && to && from.value === to.value && to.options.length > 1) {
    to.value = [...to.options].find(option => option.value !== from.value)?.value || to.value;
  }
  if ($('#move-balances')) {
    $('#move-balances').innerHTML = state.accounts.length
      ? state.accounts.map(account => `
        <div class="balance-list-row"><span>${escapeHtml(account.name)} · ••${escapeHtml(account.suffix)}</span>
        <strong>${money(account.balanceCents)}</strong></div>`).join('')
      : '<p class="empty-state">Accounts open after membership verification.</p>';
  }
}

// ---------------------------------------------------------------- navigation
const loaded = new Set();
async function setView(view, { force = false } = {}) {
  if (!VIEW_META[view]) return;
  state.view = view;
  $$('.page-view').forEach(section => section.classList.toggle('hidden', section.dataset.view !== view));
  $$('[data-view-link]').forEach(button => {
    const active = button.dataset.viewLink === view;
    button.classList.toggle('active', active);
    if (button.matches('button')) button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  const [eyebrow, title] = VIEW_META[view];
  $('#top-eyebrow').textContent = eyebrow;
  $('#page-title').textContent = title;
  $('#notification-panel')?.classList.add('hidden');
  closeAccountDetail();
  if ($('#main-content')) $('#main-content').focus({ preventScroll: true });
  if (!force && loaded.has(view)) {
    if (view === 'overview') await renderOverview();
    return;
  }
  loaded.add(view);
  try {
    await LOADERS[view]?.();
  } catch (error) {
    toast(error.message || 'Could not load this section.', 'error');
  }
}

const LOADERS = {
  overview: renderOverview,
  accounts: renderAccounts,
  move: async () => { await loadAccounts(); },
  deposit: async () => { await loadAccounts(); },
  requests: renderRequests,
  activity: renderActivity,
  card: renderCard,
  rewards: renderRewards,
  invest: renderInvestments,
  loans: renderLoans,
  support: renderCases,
  security: renderSecurity
};

// ---------------------------------------------------------------- overview
async function renderOverview() {
  const [overview] = await Promise.all([api('/overview'), loadAccounts()]);
  state.card = overview.card || state.card;
  $('#total-balance').textContent = money(overview.totalCents);
  $('#balance-subtitle').textContent = overview.accounts.length
    ? `Across ${overview.accounts.length} open account${overview.accounts.length === 1 ? '' : 's'}`
    : 'Accounts open after verification';
  $('#balance-footer-text').textContent = overview.pendingRequests
    ? `${overview.pendingRequests} money request${overview.pendingRequests === 1 ? '' : 's'} awaiting you`
    : 'Recorded ledger · updated just now';
  $('#welcome-line-text').textContent = `Good ${greeting()}, ${state.member.fullName.split(' ')[0]}.`;

  $('#overview-accounts').innerHTML = overview.accounts.length
    ? overview.accounts.map(account => `
      <article class="share-card">
        <div class="share-card-top"><span class="share-icon">▤</span><span class="share-type">${escapeHtml(account.kind)}</span></div>
        <h3>${escapeHtml(account.name)}</h3>
        <p class="share-description">••${escapeHtml(account.suffix)} · ${escapeHtml(account.accountNumber)}</p>
        <div class="share-amount">${money(account.balanceCents)}</div>
        <div class="share-bottom"><span>OPEN</span><button data-view-link="accounts">Details <span>→</span></button></div>
      </article>`).join('')
    : '<p class="empty-state">No open accounts yet. An operator opens your shares after verification.</p>';

  $('#overview-transactions').innerHTML = overview.recentTransactions.length
    ? overview.recentTransactions.map(transactionRow).join('')
    : '<p class="empty-state">No activity recorded yet.</p>';

  const card = state.card;
  $('#overview-card-dot').classList.toggle('frozen', card?.status === 'frozen');
  $('#overview-card-number').innerHTML = card ? `•••• &nbsp; •••• &nbsp; •••• &nbsp; ${escapeHtml(card.last4)}` : '•••• &nbsp; •••• &nbsp; •••• &nbsp; —';
  $('#overview-card-status').textContent = card
    ? (card.status === 'frozen' ? 'Card is frozen' : `Active · expires ${card.expires}`)
    : 'No card on file';
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function transactionRow(transaction) {
  const mine = id => state.accounts.some(account => account.id === id);
  const incoming = mine(transaction.toAccountId) && !mine(transaction.fromAccountId);
  const internal = mine(transaction.toAccountId) && mine(transaction.fromAccountId);
  const sign = incoming ? '+' : internal ? '±' : '−';
  const tone = incoming ? 'positive-text' : '';
  const icon = incoming ? '↙' : internal ? '⇄' : '↗';
  const detailParts = [shortDate(transaction.occurredAt || transaction.createdAt)];
  if (transaction.toAccountName && incoming) detailParts.push(`into ${transaction.toAccountName}`);
  else if (transaction.fromAccountName) detailParts.push(`from ${transaction.fromAccountName}`);
  if (transaction.externalReference) detailParts.push(`Ref ${transaction.externalReference}`);
  return `<div class="transaction-row">
    <span class="transaction-icon ${incoming ? 'positive' : ''}" aria-hidden="true">${icon}</span>
    <span class="transaction-main">
      <strong>${escapeHtml(transaction.description || transaction.memo || transaction.payee || statusLabel(transaction.type))}</strong>
      <small>${escapeHtml(detailParts.join(' · '))}</small>
    </span>
    <span class="transaction-meta">${badge(transaction.status)}<strong class="transaction-value ${tone}">${sign}${money(transaction.amountCents)}</strong></span>
  </div>`;
}

// ---------------------------------------------------------------- accounts
async function renderAccounts() {
  await loadAccounts();
  $('#accounts-list').innerHTML = state.accounts.length
    ? state.accounts.map(account => `
      <article class="account-card">
        <div class="account-card-head"><div><p class="eyebrow">${escapeHtml(account.kind)}</p><h3>${escapeHtml(account.name)}</h3></div>${badge(account.status)}</div>
        <div class="account-balance">${money(account.balanceCents)}</div>
        <dl class="account-meta">
          <div><dt>Account number</dt><dd>${escapeHtml(account.accountNumber)}</dd></div>
          <div><dt>Routing number</dt><dd>${escapeHtml(account.routingNumber)}</dd></div>
          <div><dt>Opened</dt><dd>${escapeHtml(shortDate(account.openedAt))}</dd></div>
        </dl>
        <button class="secondary-button" data-account-detail="${account.id}">View ledger entries</button>
      </article>`).join('')
    : '<p class="empty-state">No open accounts yet.</p>';
}

async function openAccountDetail(accountId) {
  const panel = $('#account-detail-panel');
  const result = await api(`/accounts/${accountId}`);
  panel.hidden = false;
  $('#account-detail-title').textContent = result.account.name;
  $('#account-detail-eyebrow').textContent = `LEDGER · ${result.account.accountNumber}`;
  $('#account-detail').innerHTML = `
    <div class="detail-summary"><div><span>Balance</span><strong>${money(result.account.balanceCents)}</strong></div>
    <div><span>Routing</span><strong>${escapeHtml(result.account.routingNumber)}</strong></div>
    <div><span>Status</span><strong>${escapeHtml(statusLabel(result.account.status))}</strong></div></div>
    <div class="transaction-list">${result.entries.length ? result.entries.map(entry => `
      <div class="transaction-row"><span class="transaction-icon ${entry.direction === 'credit' ? 'positive' : ''}">${entry.direction === 'credit' ? '↙' : '↗'}</span>
      <span class="transaction-main"><strong>${escapeHtml(entry.memo || 'Ledger entry')}</strong><small>${escapeHtml(fullDateTime(entry.occurredAt))} · ${escapeHtml(entry.direction)}</small></span>
      <span class="transaction-meta"><strong class="transaction-value ${entry.direction === 'credit' ? 'positive-text' : ''}">${entry.direction === 'credit' ? '+' : '−'}${money(entry.amountCents)}</strong><small>Balance ${money(entry.balanceAfterCents)}</small></span></div>`).join('')
      : '<p class="empty-state">No ledger entries recorded.</p>'}</div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeAccountDetail() {
  const panel = $('#account-detail-panel');
  if (panel) panel.hidden = true;
}

// ---------------------------------------------------------------- transfers
async function submitTransfer(form) {
  const button = form.querySelector('button[type="submit"]');
  const kind = $('#transfer-kind').value;
  const amountCents = dollarsToCents($('#transfer-amount').value);
  if (!amountCents) { toast('Enter a valid amount with up to two decimals.', 'error'); return; }
  const fromAccount = state.accounts.find(account => account.id === $('#transfer-from').value);
  const toAccount = state.accounts.find(account => account.id === $('#transfer-to').value);
  if (!fromAccount) { toast('Choose a source account.', 'error'); return; }
  const payee = $('#bill-payee').value.trim();
  if (kind === 'bill' && !payee) { toast('Enter a biller or payee name.', 'error'); return; }
  if (kind === 'share' && (!toAccount || toAccount.id === fromAccount.id)) {
    toast('Choose two different shares.', 'error'); return;
  }
  const summary = kind === 'bill'
    ? `<div>From <strong>${escapeHtml(fromAccount.name)}</strong></div><div>Payee <strong>${escapeHtml(payee)}</strong></div><div>Amount <strong>${money(amountCents)}</strong></div>`
    : `<div>From <strong>${escapeHtml(fromAccount.name)}</strong></div><div>To <strong>${escapeHtml(toAccount.name)}</strong></div><div>Amount <strong>${money(amountCents)}</strong></div>`;
  const approved = await confirmAction({
    title: kind === 'bill' ? 'Submit bill payment?' : 'Transfer between shares?',
    description: kind === 'bill'
      ? 'Bill payments are recorded and wait for operator review before the ledger posts.'
      : amountCents > 250000
        ? 'This amount is above the review limit, so it posts only after an operator approves it.'
        : 'This transfer posts immediately between your own shares.',
    summary, confirmText: kind === 'bill' ? 'Submit payment' : 'Confirm transfer'
  });
  if (!approved) return;
  setBusy(button, true, 'Submitting…');
  try {
    const payload = {
      kind, amountCents,
      fromAccountId: fromAccount.id,
      ...(kind === 'share' ? { toAccountId: toAccount.id } : { payee }),
      memo: $('#transfer-note').value.trim() || null
    };
    const result = await api('/transfers', {
      method: 'POST', body: payload,
      headers: { 'Idempotency-Key': crypto.randomUUID() }
    });
    toast(result.message || 'Transfer submitted.');
    form.reset();
    $('#bill-payee-field').classList.add('hidden');
    $('#transfer-to-label').classList.remove('hidden');
    $('#transfer-to').classList.remove('hidden');
    loaded.delete('overview');
    loaded.delete('activity');
    loaded.delete('accounts');
    await loadAccounts();
    await setView('overview', { force: true });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function updateTransferMode() {
  const kind = $('#transfer-kind').value;
  const bill = kind === 'bill';
  $('#transfer-to').classList.toggle('hidden', bill);
  $('#transfer-to-label').classList.toggle('hidden', bill);
  $('#bill-payee-field').classList.toggle('hidden', !bill);
  $('#transfer-to').required = !bill;
}

// ---------------------------------------------------------------- deposit
async function submitDeposit(form) {
  const button = form.querySelector('button[type="submit"]');
  const amountCents = dollarsToCents($('#deposit-amount').value);
  const account = state.accounts.find(item => item.id === $('#deposit-account').value);
  const description = $('#deposit-description').value.trim();
  if (!amountCents) { toast('Enter a valid check amount.', 'error'); return; }
  if (!account) { toast('Choose a deposit account.', 'error'); return; }
  if (description.length < 3) { toast('Describe the deposit.', 'error'); return; }
  const approved = await confirmAction({
    title: 'Record this deposit?',
    description: 'The deposit is validated server-side. Checks above $1,000 await operator review before posting.',
    summary: `<div>Account <strong>${escapeHtml(account.name)}</strong></div><div>Amount <strong>${money(amountCents)}</strong></div><div>Description <strong>${escapeHtml(description)}</strong></div>`,
    confirmText: 'Submit deposit'
  });
  if (!approved) return;
  setBusy(button, true, 'Submitting…');
  try {
    const result = await api('/deposits', {
      method: 'POST',
      body: { accountId: account.id, amountCents, description },
      headers: { 'Idempotency-Key': crypto.randomUUID() }
    });
    toast(result.message || 'Deposit submitted.');
    form.reset();
    $('#deposit-description').value = 'Check deposit';
    $('#check-preview-amount').textContent = '$0.00';
    loaded.delete('overview');
    loaded.delete('activity');
    await loadAccounts();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------- requests
async function renderRequests() {
  const result = await api('/requests');
  const received = $('#received-requests');
  const sent = $('#sent-requests');
  received.innerHTML = result.received.length ? result.received.map(request => `
    <div class="request-row">
      <div class="request-main"><strong>${money(request.amountCents)} from ${escapeHtml(request.requesterName)}</strong>
      <small>@${escapeHtml(request.requesterUsername)} · ${escapeHtml(request.memo || 'No memo')} · ${escapeHtml(shortDate(request.createdAt))}</small></div>
      <div class="request-actions">${badge(request.status)}
      ${request.status === 'pending' ? `<button class="primary-button small" data-pay-request="${request.id}">Pay</button>
        <button class="secondary-button small" data-decline-request="${request.id}">Decline</button>` : ''}</div>
    </div>`).join('') : '<p class="empty-state">No requests waiting for you.</p>';
  sent.innerHTML = result.sent.length ? result.sent.map(request => `
    <div class="request-row">
      <div class="request-main"><strong>${money(request.amountCents)} to ${escapeHtml(request.payerName || request.payerEmail || 'Member')}</strong>
      <small>${escapeHtml(request.memo || 'No memo')} · ${escapeHtml(shortDate(request.createdAt))}</small></div>
      <div class="request-actions">${badge(request.status)}
      ${request.status === 'pending' ? `<button class="secondary-button small" data-cancel-request="${request.id}">Cancel</button>` : ''}</div>
    </div>`).join('') : '<p class="empty-state">You have not sent any requests.</p>';
}

async function submitRequest(form) {
  const button = form.querySelector('button[type="submit"]');
  const recipient = $('#request-recipient').value.trim();
  const amountCents = dollarsToCents($('#request-amount').value);
  if (!recipient) { toast('Enter a recipient.', 'error'); return; }
  if (!amountCents) { toast('Enter a valid amount.', 'error'); return; }
  setBusy(button, true, 'Sending…');
  try {
    await api('/requests', { method: 'POST', body: { recipient, amountCents, memo: $('#request-memo').value.trim() || null } });
    toast('Request sent.');
    form.reset();
    await renderRequests();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------- activity
async function renderActivity() {
  const params = new URLSearchParams();
  const search = $('#activity-search')?.value.trim();
  const type = $('#activity-type')?.value;
  const status = $('#activity-status')?.value;
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  const result = await api(`/transactions?${params.toString()}`);
  $('#activity-list').innerHTML = result.transactions.length
    ? result.transactions.map(transaction => `
      <div class="transaction-row transaction-row-rich">
        <span class="transaction-icon" aria-hidden="true">${transaction.toAccountId && !transaction.fromAccountId ? '↙' : '↗'}</span>
        <span class="transaction-main">
          <strong>${escapeHtml(transaction.description || transaction.memo || transaction.payee || statusLabel(transaction.type))}</strong>
          <small>${escapeHtml(fullDateTime(transaction.occurredAt))} · ${escapeHtml(statusLabel(transaction.type))}
          ${transaction.externalReference ? ` · Ref ${escapeHtml(transaction.externalReference)}` : ''}</small>
          <small class="reference-line">Ledger ref ${escapeHtml(transaction.reference)}${transaction.source !== 'member' ? ` · ${escapeHtml(transaction.source)}` : ''}</small>
        </span>
        <span class="transaction-meta">${badge(transaction.status)}<strong class="transaction-value">${money(transaction.amountCents)}</strong></span>
      </div>`).join('')
    : '<p class="empty-state">No transactions match those filters.</p>';
}

// ---------------------------------------------------------------- card
async function renderCard() {
  const result = await api('/card');
  state.card = result.card;
  const card = result.card;
  if (!card) {
    $('#card-number').textContent = 'No card on file';
    $('#card-state-heading').textContent = 'No debit card yet';
    $('#card-state-description').textContent = 'A card is issued when your membership is verified.';
    $('#freeze-toggle').disabled = true;
    return;
  }
  $('#card-number').innerHTML = `•••• &nbsp; •••• &nbsp; •••• &nbsp; ${escapeHtml(card.last4)}`;
  $('#card-expires').textContent = card.expires;
  const frozen = card.status === 'frozen';
  $('#freeze-overlay').classList.toggle('hidden', !frozen);
  $('#card-state-indicator').classList.toggle('frozen', frozen);
  $('#card-state-heading').textContent = frozen ? 'Your card is frozen' : 'Your card is active';
  $('#card-state-description').textContent = frozen
    ? 'Sandbox authorizations are declined while frozen.'
    : 'Sandbox authorizations can be approved. No funds move.';
  const toggle = $('#freeze-toggle');
  toggle.disabled = false;
  toggle.textContent = frozen ? 'Unfreeze card' : 'Freeze card';
  toggle.classList.toggle('danger-button', !frozen);
}

async function toggleFreeze() {
  const frozen = state.card?.status !== 'frozen';
  const approved = await confirmAction({
    title: frozen ? 'Freeze this card?' : 'Unfreeze this card?',
    description: frozen
      ? 'Sandbox authorizations will be declined until you unfreeze the card.'
      : 'The card will accept sandbox authorizations again.',
    summary: `<div>Card <strong>•••• ${escapeHtml(state.card?.last4 || '')}</strong></div><div>New status <strong>${frozen ? 'Frozen' : 'Active'}</strong></div>`,
    confirmText: frozen ? 'Freeze card' : 'Unfreeze card',
    danger: frozen
  });
  if (!approved) return;
  try {
    const result = await api('/card/freeze', { method: 'POST', body: { frozen } });
    state.card = { ...state.card, ...result.card };
    toast(frozen ? 'Card frozen.' : 'Card unfrozen.');
    await renderCard();
    loaded.delete('overview');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function testPurchase() {
  const amountCents = dollarsToCents($('#purchase-amount').value);
  const merchant = $('#purchase-merchant').value.trim();
  const resultBox = $('#purchase-result');
  resultBox.classList.remove('hidden', 'approved', 'declined');
  if (!amountCents || !merchant) {
    resultBox.classList.add('declined');
    resultBox.textContent = 'Enter a valid amount and merchant.';
    return;
  }
  try {
    const result = await api('/card/test-purchase', { method: 'POST', body: { amountCents, merchant } });
    resultBox.classList.add('approved');
    resultBox.innerHTML = `<strong>APPROVED · SANDBOX</strong><br>${escapeHtml(result.message)} Reference ${escapeHtml(result.reference)}.`;
  } catch (error) {
    resultBox.classList.add('declined');
    resultBox.innerHTML = `<strong>DECLINED · SANDBOX</strong><br>${escapeHtml(error.message)}`;
  }
  announce(resultBox.textContent);
}

// ---------------------------------------------------------------- rewards
async function renderRewards() {
  await loadAccounts();
  const result = await api('/rewards');
  $('#rewards-points').textContent = Number(result.points).toLocaleString('en-US');
  $('#rewards-value').textContent = `${money(result.cashValueCents)} statement credit available`;
  $('#rewards-lifetime').textContent = Number(result.lifetimePoints).toLocaleString('en-US');
  $('#rewards-history').innerHTML = result.history.length ? result.history.map(entry => `
    <div class="request-row"><div class="request-main"><strong>${entry.points > 0 ? '+' : ''}${entry.points} points</strong>
    <small>${escapeHtml(entry.reason)} · ${escapeHtml(shortDate(entry.createdAt))}</small></div></div>`).join('')
    : '<p class="empty-state">No points activity yet. Deposits and payments earn points.</p>';
}

async function redeemRewards(form) {
  const button = form.querySelector('button[type="submit"]');
  const points = Number($('#rewards-points-input').value);
  if (!Number.isInteger(points) || points < 500 || points % 100 !== 0) {
    toast('Redeem at least 500 points in increments of 100.', 'error'); return;
  }
  const approved = await confirmAction({
    title: 'Redeem points?',
    description: 'A recorded statement credit is posted to the selected account.',
    summary: `<div>Points <strong>${points.toLocaleString('en-US')}</strong></div><div>Credit <strong>${money(points)}</strong></div>`,
    confirmText: 'Redeem'
  });
  if (!approved) return;
  setBusy(button, true, 'Redeeming…');
  try {
    await api('/rewards/redeem', { method: 'POST', body: { points, accountId: $('#rewards-account').value } });
    toast('Points redeemed as a recorded credit.');
    loaded.delete('overview');
    await renderRewards();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------- certificates
async function renderInvestments() {
  await loadAccounts();
  const result = await api('/investments');
  $('#certificates-list').innerHTML = result.certificates.length ? result.certificates.map(certificate => `
    <div class="statement-row">
      <div><strong>${money(certificate.amountCents)} · ${certificate.termMonths} months</strong>
      <small>Opened ${escapeHtml(shortDate(certificate.openedAt))} · Matures ${escapeHtml(shortDate(certificate.maturesAt))} · ${(certificate.apyBps / 100).toFixed(2)}% APY*</small>
      <small>Term share ${escapeHtml(certificate.accountNumber)}</small></div>
      <div class="request-actions">${badge(certificate.status)}</div>
    </div>`).join('') : '<p class="empty-state">No share certificates yet.</p>';
}

async function openCertificate(form) {
  const button = form.querySelector('button[type="submit"]');
  const amountCents = dollarsToCents($('#invest-amount').value);
  if (!amountCents || amountCents < 50000) { toast('The minimum commitment is $500.', 'error'); return; }
  const account = state.accounts.find(item => item.id === $('#invest-account').value);
  const termMonths = Number($('#invest-term').value);
  const approved = await confirmAction({
    title: 'Open a share certificate?',
    description: 'Funds move from the selected share into a term-share account in the recorded ledger.',
    summary: `<div>Amount <strong>${money(amountCents)}</strong></div><div>Term <strong>${termMonths} months</strong></div><div>From <strong>${escapeHtml(account?.name || '')}</strong></div>`,
    confirmText: 'Open certificate'
  });
  if (!approved) return;
  setBusy(button, true, 'Opening…');
  try {
    await api('/investments', { method: 'POST', body: { amountCents, termMonths, accountId: account?.id } });
    toast('Share certificate opened.');
    form.reset();
    loaded.delete('overview');
    loaded.delete('accounts');
    await renderInvestments();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------- loans
async function renderLoans() {
  await loadAccounts();
  const result = await api('/loans');
  $('#loans-list').innerHTML = result.loans.length ? result.loans.map(loan => `
    <article class="loan-card">
      <div class="loan-head"><div><p class="eyebrow">${escapeHtml(loan.product.replace(/_/g, ' '))}</p>
        <h3>${escapeHtml(loan.reference)}</h3></div>${badge(loan.status)}</div>
      <div class="loan-figures">
        <div><span>Original</span><strong>${money(loan.principalCents)}</strong></div>
        <div><span>Balance</span><strong>${money(loan.balanceCents)}</strong></div>
        <div><span>APR*</span><strong>${(loan.aprBps / 100).toFixed(2)}%</strong></div>
        <div><span>Monthly</span><strong>${loan.monthlyPaymentCents ? money(loan.monthlyPaymentCents) : '—'}</strong></div>
      </div>
      <p class="muted">${escapeHtml(loan.purpose || '')}${loan.nextDueDate ? ` · Next due ${escapeHtml(shortDate(loan.nextDueDate))}` : ''}</p>
      ${loan.status === 'active' ? `<div class="loan-repay">
        <label class="screen-reader-only" for="repay-${loan.id}">Repayment amount</label>
        <input id="repay-${loan.id}" data-repay-amount="${loan.id}" type="number" min="1" step="0.01" value="${((loan.monthlyPaymentCents || 0) / 100).toFixed(2)}">
        <button class="primary-button small" data-repay-loan="${loan.id}">Repay</button>
      </div>` : ''}
      ${loan.payments?.length ? `<div class="loan-payments">${loan.payments.slice(0, 5).map(payment => `
        <div class="loan-payment-row"><span>${escapeHtml(shortDate(payment.paidAt))} · ${escapeHtml(payment.reference || 'Ledger')}</span>
        <strong>${money(payment.amountCents)}</strong></div>`).join('')}</div>` : ''}
      ${loan.decisionReason ? `<p class="form-note">Decision note: ${escapeHtml(loan.decisionReason)}</p>` : ''}
    </article>`).join('') : '<p class="empty-state">No loan applications yet.</p>';
}

async function submitLoanApplication(form) {
  const button = form.querySelector('button[type="submit"]');
  const amountCents = dollarsToCents($('#loan-amount').value);
  const termMonths = Number($('#loan-term').value);
  const purpose = $('#loan-purpose').value.trim();
  if (!amountCents) { toast('Enter a valid loan amount.', 'error'); return; }
  if (!Number.isInteger(termMonths) || termMonths < 6 || termMonths > 84) {
    toast('Choose a term between 6 and 84 months.', 'error'); return;
  }
  if (purpose.length < 3) { toast('Describe the loan purpose.', 'error'); return; }
  const approved = await confirmAction({
    title: 'Submit loan application?',
    description: 'An operator reviews the application. Approval records a disbursement in the ledger.',
    summary: `<div>Product <strong>${escapeHtml($('#loan-product').selectedOptions[0].textContent.split('·')[0].trim())}</strong></div>
      <div>Amount <strong>${money(amountCents)}</strong></div><div>Term <strong>${termMonths} months</strong></div>`,
    confirmText: 'Submit application'
  });
  if (!approved) return;
  setBusy(button, true, 'Submitting…');
  try {
    await api('/loans', {
      method: 'POST',
      body: { product: $('#loan-product').value, principalCents: amountCents, termMonths, purpose, accountId: $('#loan-account').value }
    });
    toast('Loan application submitted for review.');
    form.reset();
    $('#loan-term').value = '36';
    await renderLoans();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function repayLoan(loanId) {
  const input = $(`[data-repay-amount="${loanId}"]`);
  const amountCents = dollarsToCents(input?.value);
  if (!amountCents) { toast('Enter a repayment amount.', 'error'); return; }
  const approved = await confirmAction({
    title: 'Make a loan repayment?',
    description: 'The repayment is debited from your first deposit share and applied to the loan.',
    summary: `<div>Amount <strong>${money(amountCents)}</strong></div>`,
    confirmText: 'Repay loan'
  });
  if (!approved) return;
  try {
    await api(`/loans/${loanId}/repay`, {
      method: 'POST',
      body: { amountCents, accountId: state.accounts[0]?.id }
    });
    toast('Repayment recorded.');
    loaded.delete('overview');
    loaded.delete('activity');
    await renderLoans();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- support
async function renderCases() {
  const result = await api('/support/cases');
  state.cases = result.cases;
  $('#cases-list').innerHTML = result.cases.length ? result.cases.map(item => `
    <button class="request-row case-row" data-case-id="${item.id}">
      <div class="request-main"><strong>${escapeHtml(item.subject)}</strong>
      <small>${escapeHtml(statusLabel(item.status))} · ${escapeHtml(shortDate(item.createdAt))} · ${item.message_count} message${Number(item.message_count) === 1 ? '' : 's'}</small></div>
      <span class="status-badge status-${statusTone(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
    </button>`).join('') : '<p class="empty-state">No support cases yet.</p>';
}

async function openCase(caseId) {
  const result = await api(`/support/cases/${caseId}`);
  state.activeCaseId = caseId;
  $('#case-thread-panel').hidden = false;
  $('#case-thread-title').textContent = result.case.subject;
  $('#case-thread-eyebrow').textContent = `CASE · ${statusLabel(result.case.status).toUpperCase()}`;
  $('#case-thread').innerHTML = result.messages.length ? result.messages.map(message => `
    <div class="case-message case-${message.authorType}">
      <span class="case-author">${message.authorType === 'member' ? 'You' : 'AVCU support'}</span>
      <p>${escapeHtml(message.body)}</p>
      <small>${escapeHtml(fullDateTime(message.createdAt))}</small>
    </div>`).join('') : '<p class="empty-state">No messages yet.</p>';
  $('#case-thread-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#case-reply').focus();
}

async function openCaseFromForm(form) {
  const button = form.querySelector('button[type="submit"]');
  const subject = $('#case-subject').value.trim();
  const body = $('#case-message').value.trim();
  if (subject.length < 3) { toast('Enter a subject.', 'error'); return; }
  if (!body) { toast('Describe what you need help with.', 'error'); return; }
  setBusy(button, true, 'Opening…');
  try {
    const result = await api('/support/cases', { method: 'POST', body: { subject, body } });
    form.reset();
    toast('Support case opened.');
    await renderCases();
    await openCase(result.case.id);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------- security
async function renderSecurity() {
  const member = state.member;
  $('#identity-status').textContent = statusLabel(member.status).toUpperCase();
  $('#identity-list').innerHTML = `
    <div><dt>Full name</dt><dd>${escapeHtml(member.fullName)}</dd></div>
    <div><dt>Member number</dt><dd>${escapeHtml(member.memberNumber)}</dd></div>
    <div><dt>Username</dt><dd>@${escapeHtml(member.username)}</dd></div>
    <div><dt>Email</dt><dd>${escapeHtml(member.email)}</dd></div>
    <div><dt>Membership</dt><dd>${escapeHtml(statusLabel(member.status))}</dd></div>
    <div><dt>Email verified</dt><dd>${member.emailVerified ? 'Yes' : 'No'}</dd></div>`;
  $('#profile-phone').value = member.phone || '';
  $('#profile-address').value = member.mailingAddress || '';
  $('#email-verification-copy').textContent = member.emailVerified
    ? 'Your email address is verified.'
    : 'Verify the email address on your membership to receive notices.';
  $('#request-verification').disabled = member.emailVerified;
  $('#session-copy').textContent = `Signed in as @${member.username}. Sessions are server-side and expire automatically; sign out to end this one.`;
}

async function requestVerification() {
  try {
    const result = await api('/auth/email/verification-code', { method: 'POST' });
    if (result.alreadyVerified) { toast('Email already verified.'); return; }
    $('#verify-form').classList.remove('hidden');
    $('#verification-delivery').textContent = result.message;
    if (result.code) {
      $('#verify-code').value = result.code;
      toast('A verification code is shown below (development delivery).');
    } else {
      toast('Verification code sent.');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function verifyEmail(form) {
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Verifying…');
  try {
    await api('/auth/email/verify', { method: 'POST', body: { code: $('#verify-code').value.trim() } });
    state.member = { ...state.member, emailVerified: true };
    toast('Email verified.');
    await renderSecurity();
    $('#verify-form').classList.add('hidden');
    $('#verification-delivery').textContent = '';
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function changePassword(form) {
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Updating…');
  try {
    await api('/auth/password', {
      method: 'POST',
      body: { currentPassword: $('#current-password').value, newPassword: $('#new-password').value }
    });
    form.reset();
    toast('Password updated. Other sessions were signed out.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function saveProfile(form) {
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    const result = await api('/profile', {
      method: 'PATCH',
      body: { phone: $('#profile-phone').value, mailingAddress: $('#profile-address').value }
    });
    state.member = { ...state.member, ...result.profile };
    toast('Profile saved.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------- notifications
function renderNotifications() {
  const unread = state.notifications.filter(item => !item.read).length;
  const count = $('#notification-count');
  count.textContent = String(unread);
  count.classList.toggle('hidden', unread === 0);
  $('#notification-list').innerHTML = state.notifications.length
    ? state.notifications.map(item => `
      <div class="notification-item ${item.read ? '' : 'unread'}">
        <span class="notification-dot"></span>
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p><small>${escapeHtml(shortDate(item.createdAt))}</small></div>
      </div>`).join('')
    : '<p class="empty-state">No notifications.</p>';
}

async function markNotificationsRead() {
  try {
    await api('/notifications/mark-read', { method: 'POST' });
    state.notifications = state.notifications.map(item => ({ ...item, read: true }));
    renderNotifications();
    announce('Notifications marked read.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- global events
function bindGlobalEvents() {
  document.addEventListener('click', async event => {
    const nav = event.target.closest('[data-view-link]');
    if (nav && state.member) {
      event.preventDefault();
      await setView(nav.dataset.viewLink);
      return;
    }
    const detail = event.target.closest('[data-account-detail]');
    if (detail) { await openAccountDetail(detail.dataset.accountDetail).catch(error => toast(error.message, 'error')); return; }
    if (event.target.closest('#account-detail-close')) { closeAccountDetail(); return; }

    const pay = event.target.closest('[data-pay-request]');
    if (pay) { await payRequest(pay.dataset.payRequest); return; }
    const decline = event.target.closest('[data-decline-request]');
    if (decline) { await closeRequest(decline.dataset.declineRequest, 'decline'); return; }
    const cancel = event.target.closest('[data-cancel-request]');
    if (cancel) { await closeRequest(cancel.dataset.cancelRequest, 'cancel'); return; }

    const repay = event.target.closest('[data-repay-loan]');
    if (repay) { await repayLoan(repay.dataset.repayLoan); return; }

    const caseRow = event.target.closest('[data-case-id]');
    if (caseRow) { await openCase(caseRow.dataset.caseId).catch(error => toast(error.message, 'error')); return; }
    if (event.target.closest('#case-thread-close')) { $('#case-thread-panel').hidden = true; return; }

    if (event.target.closest('#freeze-toggle')) { await toggleFreeze(); return; }
    if (event.target.closest('#simulate-purchase')) { await testPurchase(); return; }
    if (event.target.closest('#request-verification')) { await requestVerification(); return; }
    if (event.target.closest('#mark-notifications-read')) { await markNotificationsRead(); return; }
    if (event.target.closest('#sign-out-button') || event.target.closest('#logout-button')) { await doSignOut(); return; }

    const bell = event.target.closest('#notification-button');
    if (bell) {
      const panel = $('#notification-panel');
      const open = panel.classList.toggle('hidden');
      bell.setAttribute('aria-expanded', String(!open));
      return;
    }
    if (!event.target.closest('.notification-wrap')) {
      $('#notification-panel')?.classList.add('hidden');
      $('#notification-button')?.setAttribute('aria-expanded', 'false');
    }
  });

  $('#transfer-form').addEventListener('submit', event => { event.preventDefault(); submitTransfer(event.currentTarget); });
  $('#transfer-kind').addEventListener('change', updateTransferMode);
  $('#transfer-from').addEventListener('change', () => {
    const from = $('#transfer-from');
    const to = $('#transfer-to');
    if (from.value === to.value && to.options.length > 1) {
      to.value = [...to.options].find(option => option.value !== from.value)?.value || to.value;
    }
  });
  $('#swap-shares').addEventListener('click', () => {
    const from = $('#transfer-from');
    const to = $('#transfer-to');
    const previous = from.value;
    from.value = to.value;
    to.value = previous;
  });
  $('#deposit-form').addEventListener('submit', event => { event.preventDefault(); submitDeposit(event.currentTarget); });
  $('#deposit-amount').addEventListener('input', event => {
    const cents = dollarsToCents(event.target.value);
    $('#check-preview-amount').textContent = cents ? money(cents) : '$0.00';
  });
  $('#request-form').addEventListener('submit', event => { event.preventDefault(); submitRequest(event.currentTarget); });
  $('#activity-filter').addEventListener('submit', event => { event.preventDefault(); renderActivity().catch(error => toast(error.message, 'error')); });
  $('#rewards-form').addEventListener('submit', event => { event.preventDefault(); redeemRewards(event.currentTarget); });
  $('#invest-form').addEventListener('submit', event => { event.preventDefault(); openCertificate(event.currentTarget); });
  $('#loan-form').addEventListener('submit', event => { event.preventDefault(); submitLoanApplication(event.currentTarget); });
  $('#case-form').addEventListener('submit', event => { event.preventDefault(); openCaseFromForm(event.currentTarget); });
  $('#case-reply-form').addEventListener('submit', async event => {
    event.preventDefault();
    const body = $('#case-reply').value.trim();
    if (!body || !state.activeCaseId) return;
    try {
      await api(`/support/cases/${state.activeCaseId}/messages`, { method: 'POST', body: { body } });
      $('#case-reply').value = '';
      await openCase(state.activeCaseId);
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#profile-form').addEventListener('submit', event => { event.preventDefault(); saveProfile(event.currentTarget); });
  $('#password-form').addEventListener('submit', event => { event.preventDefault(); changePassword(event.currentTarget); });
  $('#verify-form').addEventListener('submit', event => { event.preventDefault(); verifyEmail(event.currentTarget); });
  $('#verification-delivery')?.addEventListener('click', () => {});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      $('#notification-panel')?.classList.add('hidden');
      closeAccountDetail();
    }
  });
}

async function payRequest(requestId) {
  const account = state.accounts[0];
  if (!account) { toast('No open account to pay from.', 'error'); return; }
  const approved = await confirmAction({
    title: 'Pay this request?',
    description: 'The amount is debited from your first deposit share. Amounts above $2,500 await approval.',
    summary: `<div>From <strong>${escapeHtml(account.name)}</strong></div><div>Account balance <strong>${money(account.balanceCents)}</strong></div>`,
    confirmText: 'Pay request'
  });
  if (!approved) return;
  try {
    const result = await api(`/requests/${requestId}/pay`, { method: 'POST', body: { accountId: account.id } });
    toast(result.message || 'Payment sent.');
    loaded.delete('overview');
    await renderRequests();
    await loadAccounts();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function closeRequest(requestId, action) {
  const approved = await confirmAction({
    title: action === 'decline' ? 'Decline this request?' : 'Cancel this request?',
    description: action === 'decline'
      ? 'The requester will see that you declined. No money moves.'
      : 'The request is withdrawn. No money moves.',
    confirmText: action === 'decline' ? 'Decline request' : 'Cancel request',
    danger: action === 'decline'
  });
  if (!approved) return;
  try {
    await api(`/requests/${requestId}/${action}`, { method: 'POST' });
    toast(action === 'decline' ? 'Request declined.' : 'Request cancelled.');
    await renderRequests();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function doSignOut() {
  await signOut();
  state.member = null;
  state.accounts = [];
  state.notifications = [];
  loaded.clear();
  $('#member-app').classList.add('hidden');
  $('#mobile-nav').classList.add('hidden');
  $('#assistant-panel')?.classList.add('hidden');
  auth.show();
  toast('Signed out.');
}

boot();
