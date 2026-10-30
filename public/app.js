(() => {
  'use strict';

  const STORAGE_KEY = 'avcu.member.v1';
  const MAX_TRANSACTIONS = 100;
  const accounts = {
    draft: { name: 'Share Draft (Checking)', kind: 'EVERYDAY' },
    primary: { name: 'Primary Share (Savings)', kind: 'SAVINGS' },
    market: { name: 'Money Market', kind: 'GROWTH' },
    holiday: { name: 'Holiday Club', kind: 'GOAL SAVINGS' },
    business: { name: 'Business Operating Account', kind: 'BUSINESS' },
    ira: { name: 'Traditional IRA', kind: 'RETIREMENT' },
    certificate: { name: 'Share Certificate', kind: 'TERM SAVINGS' },
    retirement401k: { name: '401(k) Retirement', kind: 'RETIREMENT' }
  };
  const seed = {
    balances: { draft: 0, primary: 0, market: 0, holiday: 0, business: 0, ira: 0, certificate: 0, retirement401k: 0 },
    frozen: false,
    transactions: []
  };
  let state = loadState();
  let currentView = 'home';
  let pendingAction = null;
  let toastTimer = null;
  let historySnapshot = null;
  let historyError = '';
  let historyLoading = false;
  let historyLoadVersion = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const cents = value => Math.round(Number(value) * 100);
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
  const safeMoneyInput = value => { const amount = Number(value); return Number.isFinite(amount) && amount > 0 && amount <= 1000000 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7 && Number.isSafeInteger(Math.round(amount * 100)); };
  const total = () => Object.values(state.balances).reduce((sum, value) => sum + value, 0);
  const createId = () => (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `avcu-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return cloneSeed();
      const parsed = JSON.parse(saved);
      if (!parsed || typeof parsed !== 'object' || !parsed.balances || !Array.isArray(parsed.transactions) ||
          Object.entries(parsed.balances).some(([key, value]) => !accounts[key] || !Number.isSafeInteger(value) || value < 0) ||
          typeof parsed.frozen !== 'boolean' ||
          parsed.transactions.some(t => !t || typeof t.id !== 'string' || typeof t.title !== 'string' ||
            !Number.isSafeInteger(t.amount) || typeof t.account !== 'string' || !accounts[t.account] || typeof t.date !== 'string')) {
        return cloneSeed();
      }
      // Migrate older locally stored account records without discarding balances or history.
      const balances = { ...seed.balances, ...parsed.balances };
      for (const key of Object.keys(accounts)) if (!Object.hasOwn(parsed.balances, key)) balances[key] = 0;
      for (const key of Object.keys(accounts)) if (!Object.hasOwn(balances, key)) balances[key] = 0;
      return { balances, frozen: parsed.frozen, transactions: parsed.transactions.slice(0, MAX_TRANSACTIONS) };
    } catch {
      return cloneSeed();
    }
  }

  function cloneSeed() {
    return { balances: { ...seed.balances }, frozen: seed.frozen, transactions: seed.transactions.map(t => ({ ...t })) };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      showToast('Local storage is unavailable. Your changes may not persist after refresh.', 'error');
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function shortDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return `Today · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function announce(message) {
    const region = $('#live-announcer');
    if (region) region.textContent = message;
  }

  function showToast(message, type = 'success') {
    const region = $('#toast-region');
    if (!region) return;
    region.replaceChildren();
    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' error' : ''}`;
    toast.textContent = message;
    region.append(toast);
    announce(message);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 4200);
  }

  function setView(view) {
    if (!['home', 'transactions', 'move', 'deposit', 'card', 'operations', 'more'].includes(view)) return;
    currentView = view;
    $$('.page-view').forEach(el => el.classList.toggle('hidden', el.dataset.view !== view));
    $$('[data-nav]').forEach(button => {
      const active = button.dataset.nav === view;
      button.classList.toggle('active', active);
      if (button.matches('button')) button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const copy = {
      home: ['MEMBER OVERVIEW', 'Welcome to AVCU'],
      transactions: ['MEMBER ACCOUNT ACTIVITY', 'Transaction history'],
      move: ['MOVE MONEY', 'Payment requests'],
      deposit: ['DEPOSIT', 'Deposit a check'],
      card: ['CARD CONTROLS', 'Your debit card'],
      operations: ['PAYMENT WORKSPACE', 'Payments & approvals'],
      more: ['MEMBER RESOURCES', 'More from AVCU']
    }[view];
    $('#top-eyebrow').textContent = copy[0];
    $('#page-title').textContent = copy[1];
    if (view === 'move') renderMoveBalances();
    if (view === 'transactions') { renderTransactionHistory(); loadTransactionHistory(); }
    if (view === 'operations' && typeof window.renderWorkflowWorkspace === 'function') window.renderWorkflowWorkspace();
    if (view === 'more') renderAllTransactions();
    $('#main-content').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function transactionMarkup(transaction) {
    const isPositive = transaction.amount >= 0;
    const amountText = `${isPositive ? '+' : '−'}${money(Math.abs(transaction.amount))}`;
    return `<div class="transaction-row">
      <span class="transaction-icon ${isPositive ? 'positive' : ''}" aria-hidden="true">${isPositive ? '↙' : (transaction.detail === 'Share transfer' ? '⇄' : '↗')}</span>
      <span class="transaction-main"><strong>${escapeHtml(transaction.title)}</strong><small>${escapeHtml(shortDate(transaction.date))} · ${escapeHtml(accounts[transaction.account].name)}</small></span>
      <strong class="transaction-value ${isPositive ? 'positive-text' : ''}">${amountText}</strong>
    </div>`;
  }

  function renderHome() {
    $('#total-balance').textContent = 'Not connected';
    $$('[data-balance]').forEach(el => {
      const account = el.dataset.balance;
      if (accounts[account]) el.textContent = 'Not connected';
    });
    const recent = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 4);
    $('#recent-transactions').innerHTML = recent.length ? recent.map(transactionMarkup).join('') : '<p class="empty-state">No account activity yet. Start a payment or deposit request.</p>';
    $('#card-status-dot').classList.toggle('frozen', state.frozen);
    $('#card-status-text').textContent = state.frozen ? 'Local controls frozen' : 'Issuer not connected';
    $('#today-label').textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    $('#ledger-count').textContent = String(state.transactions.length);
    $('#ledger-card-status').textContent = state.frozen ? 'Frozen locally' : 'Not connected';
  }

  function renderMoveBalances() {
    $('#move-balances').innerHTML = Object.keys(accounts).map(key =>
      `<div class="balance-list-row"><span>${escapeHtml(accounts[key].name)}</span><strong>Not connected</strong></div>`
    ).join('');
    updateTransferMode();
  }

  function renderAllTransactions() {
    const rows = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
    $('#all-transactions').innerHTML = rows.length ? rows.map(transactionMarkup).join('') : '<p class="empty-state">No account activity yet.</p>';
    $('#ledger-count').textContent = String(state.transactions.length);
    $('#ledger-card-status').textContent = state.frozen ? 'Frozen locally' : 'Not connected';
  }

  const accountLabels = {
    draft: 'Share Draft (Checking)', primary: 'Primary Share (Savings)', market: 'Money Market',
    holiday: 'Holiday Club', business: 'Business Operating Account', ira: 'Traditional IRA',
    certificate: 'Share Certificate', retirement401k: '401(k) Retirement'
  };
  const requestLabels = {
    'internal-transfer': 'Internal account transfer', 'bill-payment': 'Bill payment',
    'wire-transfer': 'Wire transfer', zelle: 'Zelle payment', fx: 'Foreign exchange',
    withdrawal: 'Withdrawal', ira: 'IRA request', '401k': '401(k) request',
    'check-deposit': 'Check deposit', 'card-authorization': 'Card authorization'
  };
  const statusLabels = {
    'pending-approval': 'Pending approval', 'needs-information': 'Needs information',
    rejected: 'Rejected', approved: 'Approved', 'approved-awaiting-provider': 'Approved · Awaiting provider',
    processing: 'Processing · Provider accepted', settled: 'Settled · Provider confirmed'
  };
  const formatHistoryDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(date);
  };
  const safeCents = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;

  function renderTransactionHistory() {
    const status = $('#history-status');
    const copy = $('#copy-history');
    if (!status) return;
    const auth = window.AVCUAuthState || {};
    if (!auth.ready) {
      status.textContent = 'Checking your secure member session…';
      copy.disabled = true;
      return;
    }
    if (!auth.user) {
      status.textContent = 'Sign in with your member account to view private transaction history.';
      ['history-credits','history-debits','history-pending-wires','history-pending-bills'].forEach(id => { if ($('#'+id)) $('#'+id).textContent = '—'; });
      $('#history-monthly').innerHTML = '<p class="empty-state">Member sign-in is required to view account activity.</p>';
      $('#history-entries').innerHTML = '<p class="empty-state">No shared account entries are displayed while signed out.</p>';
      $('#history-requests').innerHTML = '<p class="empty-state">Sign in to view your wire and payment requests.</p>';
      $('#history-entry-count').textContent = '0 entries';
      copy.disabled = true;
      return;
    }
    if (historyLoading) {
      status.textContent = 'Loading your private account history…';
      copy.disabled = true;
      return;
    }
    if (historyError) {
      status.textContent = 'Transaction history is unavailable: ' + historyError;
      $('#history-monthly').innerHTML = '<p class="empty-state">The shared history service could not be reached. Local sample data was not substituted.</p>';
      $('#history-entries').innerHTML = '<p class="empty-state">Posted transactions could not be loaded.</p>';
      $('#history-requests').innerHTML = '<p class="empty-state">Wire and payment requests could not be loaded.</p>';
      copy.disabled = true;
      return;
    }

    const snapshot = historySnapshot || { ledger: [], monthly: [], requests: [] };
    const ledger = Array.isArray(snapshot.ledger) ? snapshot.ledger : [];
    const monthly = Array.isArray(snapshot.monthly) ? snapshot.monthly : [];
    const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
    const credits = ledger.filter(row => row.direction === 'credit').reduce((sum,row) => sum + safeCents(row.amount_cents), 0);
    const debits = ledger.filter(row => row.direction === 'debit').reduce((sum,row) => sum + safeCents(row.amount_cents), 0);
    const isPending = row => !['settled','rejected','approved'].includes(row.status);
    const pendingWires = requests.filter(row => row.type === 'wire-transfer' && isPending(row)).reduce((sum,row) => sum + safeCents(row.amount_cents), 0);
    const pendingBills = requests.filter(row => row.type === 'bill-payment' && isPending(row)).reduce((sum,row) => sum + safeCents(row.amount_cents), 0);
    $('#history-credits').textContent = money(credits);
    $('#history-debits').textContent = money(debits);
    $('#history-pending-wires').textContent = money(pendingWires);
    $('#history-pending-bills').textContent = money(pendingBills);
    status.textContent = 'Showing your member-only records from the last 365 days. Pending external requests are not included in posted totals.';
    copy.disabled = false;

    const monthMap = new Map(monthly.map(row => [row.month_key, row]));
    const now = new Date();
    const monthRows = Array.from({ length: 12 }, (_, index) => new Date(now.getFullYear(), now.getMonth() - 11 + index, 1));
    $('#history-monthly').innerHTML = '<table class="history-table"><thead><tr><th>Month</th><th>Money in</th><th>Money out</th><th>Net movement</th></tr></thead><tbody>' +
      monthRows.map(date => {
        const key = date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0');
        const row = monthMap.get(key) || {};
        const incoming = safeCents(row.credits_cents), outgoing = safeCents(row.debits_cents), net = incoming - outgoing;
        return '<tr><td>' + escapeHtml(date.toLocaleDateString('en-US',{month:'short',year:'numeric'})) + '</td><td class="history-positive">' + money(incoming) + '</td><td>' + money(outgoing) + '</td><td class="' + (net >= 0 ? 'history-positive' : 'history-negative') + '">' + (net > 0 ? '+' : net < 0 ? '−' : '') + money(Math.abs(net)) + '</td></tr>';
      }).join('') + '</tbody></table>';

    const sortedLedger = [...ledger].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    $('#history-entry-count').textContent = sortedLedger.length + ' posted entries';
    $('#history-entries').innerHTML = sortedLedger.length ? sortedLedger.map(row => {
      const positive = row.direction === 'credit';
      const label = row.request_type === 'internal-transfer' ? 'Account transfer' : (requestLabels[row.request_type] || 'Account activity');
      const title = row.purpose || label;
      const amount = safeCents(row.amount_cents);
      return '<article class="history-entry"><div class="history-entry-main"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(formatHistoryDate(row.created_at)) + ' · ' + escapeHtml(accountLabels[row.account_type] || row.account_type) + '</small><small>Reference ' + escapeHtml(String(row.request_id || '').slice(0,8).toUpperCase()) + ' · Posted</small></div><strong class="' + (positive ? 'history-positive' : 'history-negative') + '">' + (positive ? '+' : '−') + money(amount) + '</strong></article>';
    }).join('') : '<p class="empty-state">No posted account entries were found in the last 365 days. Requests awaiting review or provider settlement appear below.</p>';

    const sortedRequests = [...requests].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    $('#history-requests').innerHTML = sortedRequests.length ? sortedRequests.map(row => {
      const title = requestLabels[row.type] || row.type;
      const recipient = row.recipient ? ' · ' + row.recipient : '';
      return '<article class="history-entry"><div class="history-entry-main"><strong>' + escapeHtml(title + recipient) + '</strong><small>' + escapeHtml(formatHistoryDate(row.created_at)) + ' · ' + escapeHtml(row.purpose || '') + '</small><small>Reference ' + escapeHtml(String(row.id || '').slice(0,8).toUpperCase()) + '</small></div><span class="history-status-pill">' + escapeHtml(statusLabels[row.status] || row.status) + '</span><strong>' + money(safeCents(row.amount_cents)) + '</strong></article>';
    }).join('') : '<p class="empty-state">No wire or payment requests were found in the last 365 days.</p>';
  }

  async function loadTransactionHistory() {
    const auth = window.AVCUAuthState || {};
    if (!auth.ready) return;
    if (!auth.user) { historySnapshot = null; historyError = ''; historyLoading = false; renderTransactionHistory(); return; }
    const version = ++historyLoadVersion;
    historyLoading = true; historyError = ''; renderTransactionHistory();
    try {
      const response = await fetch('/api/workflow?scope=history', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Shared member history service is unavailable.');
      if (version !== historyLoadVersion) return;
      historySnapshot = {
        ledger: Array.isArray(data.ledger) ? data.ledger : [],
        monthly: Array.isArray(data.monthly) ? data.monthly : [],
        requests: Array.isArray(data.requests) ? data.requests : []
      };
      historyError = '';
    } catch (error) {
      if (version !== historyLoadVersion) return;
      historySnapshot = null;
      historyError = error?.message || 'Shared member history service is unavailable.';
    } finally {
      if (version === historyLoadVersion) { historyLoading = false; renderTransactionHistory(); }
    }
  }

  async function copyTransactionStatement() {
    if (!historySnapshot || historyError || !window.AVCUAuthState?.user) return;
    const ledger = historySnapshot.ledger || [], requests = historySnapshot.requests || [];
    const lines = ['ATCHISON VILLAGE CREDIT UNION', 'MEMBER TRANSACTION HISTORY', 'Period: Last 365 days', ''];
    const credits = ledger.filter(row=>row.direction==='credit').reduce((sum,row)=>sum+safeCents(row.amount_cents),0);
    const debits = ledger.filter(row=>row.direction==='debit').reduce((sum,row)=>sum+safeCents(row.amount_cents),0);
    lines.push('Posted money in: '+money(credits),'Posted money out: '+money(debits),'Net movement: '+money(credits-debits),'','POSTED TRANSACTIONS');
    for (const row of [...ledger].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))) {
      lines.push(formatHistoryDate(row.created_at)+' | '+(row.direction==='credit'?'Credit':'Debit')+' | '+(accountLabels[row.account_type]||row.account_type)+' | '+money(safeCents(row.amount_cents))+' | Ref '+String(row.request_id||'').slice(0,8).toUpperCase());
    }
    lines.push('','WIRE & PAYMENT REQUESTS');
    for (const row of [...requests].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))) {
      lines.push(formatHistoryDate(row.created_at)+' | '+(requestLabels[row.type]||row.type)+' | '+money(safeCents(row.amount_cents))+' | '+(statusLabels[row.status]||row.status)+' | Ref '+String(row.id||'').slice(0,8).toUpperCase());
    }
    try { await navigator.clipboard.writeText(lines.join('\n')); showToast('Member transaction statement copied.'); }
    catch { showToast('Copy is unavailable in this browser. Open the history and copy the visible records.', 'error'); }
  }

  function renderCard() {
    $('#freeze-overlay').classList.toggle('hidden', !state.frozen);
    $('#large-card-preview').setAttribute('aria-label', state.frozen ? 'Card controls frozen locally' : 'Card issuer not connected');
    $('#card-state-indicator').classList.toggle('frozen', state.frozen);
    $('#card-state-heading').textContent = state.frozen ? 'Card frozen locally' : 'Issuer not connected';
    $('#card-state-description').textContent = state.frozen ? 'New purchase authorizations will be declined locally.' : 'Purchase authorizations can be recorded locally.';
    $('#freeze-toggle').textContent = state.frozen ? 'Unfreeze card' : 'Freeze card';
    $('#freeze-toggle').classList.toggle('danger-button', !state.frozen);
    $('#card-status-dot').classList.toggle('frozen', state.frozen);
    $('#card-status-text').textContent = state.frozen ? 'Card frozen locally' : 'Issuer not connected';
    $('#ledger-card-status').textContent = state.frozen ? 'Frozen locally' : 'Not connected';
  }

  function renderAll() {
    renderHome();
    renderMoveBalances();
    renderCard();
    if (currentView === 'more') renderAllTransactions();
  }

  window.renderAll = renderAll;
  window.addEventListener('avcu:member-state-updated', () => { state = loadState(); renderAll(); });

  function addTransaction(account, title, amount, detail) {
    state.transactions.unshift({ id: createId(), account, title, amount, date: new Date().toISOString(), detail });
    state.transactions = state.transactions.slice(0, MAX_TRANSACTIONS);
  }

  function showConfirm({ title, description, summary, confirmText = 'Confirm request', onConfirm }) {
    pendingAction = onConfirm;
    $('#dialog-title').textContent = title;
    $('#dialog-description').textContent = description;
    $('#dialog-summary').innerHTML = summary;
    $('#dialog-confirm').textContent = confirmText;
    const dialog = $('#confirm-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {
      const ok = window.confirm(`${title}\n\n${description}\n\n${$('#dialog-summary').textContent}`);
      if (ok && pendingAction) pendingAction();
      pendingAction = null;
    }
  }

  function performPendingAction(event) {
    if (event.submitter && event.submitter.value !== 'confirm') {
      pendingAction = null;
      return;
    }
    if (pendingAction) {
      const action = pendingAction;
      pendingAction = null;
      action();
    }
  }

  function renderAccountGuidance() {
    const selected = [$('#transfer-from')?.value, $('#transfer-to')?.value].filter(Boolean);
    const messages = {
      ira: 'Traditional IRA requests require eligibility, tax, contribution, and withdrawal rules to be verified by the authorized provider.',
      certificate: 'Share Certificate terms, maturity dates, and early-withdrawal rules must be verified before processing.',
      business: 'Business account activity requires appropriate business verification and permissions.'
    };
    const uniqueMessages = [...new Set(selected.map(key => messages[key]).filter(Boolean))];
    const transferNote = $('#account-guidance');
    if (transferNote) {
      transferNote.textContent = uniqueMessages.length ? uniqueMessages.join(' ') : 'Account types and movement rules are illustrative; no real account terms apply.';
      transferNote.classList.toggle('hidden', uniqueMessages.length === 0);
    }
    const depositNote = $('#deposit-account-guidance');
    if (depositNote) {
      const key = $('#deposit-account')?.value;
      depositNote.textContent = messages[key] || 'This is a local request record; final posting requires an authorized deposit-processing connection.';
      depositNote.classList.toggle('hidden', !messages[key]);
    }
  }

  function updateTransferMode() {
    const kind = $('#transfer-kind')?.value || 'share';
    const isBill = kind === 'bill';
    const from = $('#transfer-from');
    const to = $('#transfer-to');
    const toLabel = $('#transfer-to-label');
    const payeeField = $('#bill-payee-field');
    if (!from || !to || !toLabel || !payeeField) return;
    if (isBill) {
      from.value = 'draft';
      from.disabled = true;
      toLabel.classList.add('hidden');
      to.classList.add('hidden');
      to.required = false;
      payeeField.classList.remove('hidden');
    } else {
      from.disabled = false;
      toLabel.classList.remove('hidden');
      to.classList.remove('hidden');
      to.required = true;
      payeeField.classList.add('hidden');
      if (from.value === to.value) {
        const other = Object.keys(accounts).find(key => key !== from.value);
        to.value = other || 'primary';
      }
    }
    renderAccountGuidance();
  }

  function submitTransfer() {
    showToast('Payment workflow is unavailable. No transaction was posted.', 'error');
  }

  function submitDeposit() {
    showToast('Deposit workflow is unavailable. No account was credited.', 'error');
  }

  function toggleFreeze() {
    const next = !state.frozen;
    showConfirm({
      title: next ? 'Freeze local card controls?' : 'Unfreeze local card controls?',
      description: next ? 'New local purchase authorization requests will be blocked.' : 'Local purchase authorization requests can be submitted for review. This does not change an external card issuer status.',
      summary: `<div>Card <strong>Issuer not connected</strong></div><div>New status <strong>${next ? 'Frozen' : 'Active'}</strong></div>`,
      confirmText: next ? 'Freeze card' : 'Unfreeze card',
      onConfirm: () => {
        state.frozen = next;
        saveState();
        renderCard();
        renderHome();
        showToast(next ? 'Card frozen. New local purchase authorizations will decline.' : 'Card unfrozen. Local purchase authorizations can be recorded.');
      }
    });
  }

  function simulatePurchase() {
    showToast('Purchase authorization workflow is unavailable. No merchant authorization or account debit occurred.', 'error');
  }

  function resetLocalWorkspace() {
    showConfirm({
      title: 'Reset local account workspace?',
      description: 'This clears locally stored account records and restores empty account balances on this device. It does not change records held by any financial institution.',
      summary: '<div>Accounts <strong>8 local account records</strong></div><div>Activity <strong>Local transaction history</strong></div><div>Card <strong>Active</strong></div>',
      confirmText: 'Reset local records',
      onConfirm: () => {
        state = cloneSeed();
        saveState();
        window.dispatchEvent(new CustomEvent('avcu:reset-workflow'));
        renderAll();
        renderAllTransactions();
        showToast('Local account workspace reset.');
      }
    });
  }

  function showHelp() {
    showConfirm({
      title: 'About standalone operations',
      description: 'Standalone mode stores local records and approval requests in this browser. External payment execution, account verification, and settlement require authorized financial-institution and provider integrations. This workspace does not establish deposit insurance or a banking charter.',
      summary: '<div>External provider connection <strong>Not configured</strong></div><div>Request tracking <strong>Available locally</strong></div><div>External settlement <strong>Unavailable until connected</strong></div><div>Storage <strong>This browser only</strong></div>',
      confirmText: 'Got it',
      onConfirm: () => {}
    });
  }

  function bindEvents() {
    document.addEventListener('click', event => {
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        event.preventDefault();
        setView(nav.dataset.nav);
      }
      const fromButton = event.target.closest('[data-transfer-from]');
      if (fromButton) {
        setView('move');
        $('#transfer-kind').value = 'share';
        $('#transfer-from').value = fromButton.dataset.transferFrom;
        updateTransferMode();
        $('#transfer-amount').focus();
      }
    });

    $('#transfer-form').addEventListener('submit', event => {
      event.preventDefault();
      submitTransfer(event.currentTarget);
    });
    $('#deposit-form').addEventListener('submit', event => {
      event.preventDefault();
      submitDeposit(event.currentTarget);
    });
    $('#transfer-kind').addEventListener('change', updateTransferMode);
    $('#transfer-from').addEventListener('change', updateTransferMode);
    $('#transfer-to').addEventListener('change', renderAccountGuidance);
    $('#deposit-account').addEventListener('change', renderAccountGuidance);
    $('#swap-shares').addEventListener('click', () => {
      const from = $('#transfer-from');
      const to = $('#transfer-to');
      const previousFrom = from.value;
      from.value = to.value;
      to.value = previousFrom;
      updateTransferMode();
    });
    $('#deposit-amount').addEventListener('input', event => {
      const amount = Number(event.target.value);
      $('#check-preview-amount').textContent = safeMoneyInput(amount) ? money(cents(amount)) : '$0.00';
    });
    $('#freeze-toggle').addEventListener('click', toggleFreeze);
    $('#simulate-purchase').addEventListener('click', simulatePurchase);
    $('#reset-local-workspace').addEventListener('click', resetLocalWorkspace);
    $('#help-button').addEventListener('click', showHelp);
    $('#copy-history')?.addEventListener('click', copyTransactionStatement);
    $('#confirm-dialog').addEventListener('close', () => { pendingAction = null; });
    $('#confirm-dialog').addEventListener('submit', event => {
      if (event.submitter && event.submitter.value === 'confirm') {
        event.preventDefault();
        const dialog = $('#confirm-dialog');
        const action = pendingAction;
        pendingAction = null;
        dialog.close('confirm');
        if (action) action();
      }
    });
    $('#transfer-from').addEventListener('change', () => {
      if ($('#transfer-from').value === $('#transfer-to').value) {
        const alternative = Object.keys(accounts).find(key => key !== $('#transfer-from').value);
        if (alternative) $('#transfer-to').value = alternative;
      }
    });
  }

  function init() {
    bindEvents();
    renderAll();
    window.addEventListener('avcu:auth-state-updated', loadTransactionHistory);
    window.addEventListener('avcu:workflow-history-updated', loadTransactionHistory);
    if (window.AVCUAuthState?.ready) loadTransactionHistory();
    renderAccountGuidance();
    const date = $('#today-label');
    if (date) date.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    if (!('showModal' in HTMLDialogElement.prototype)) {
      $('#confirm-dialog').addEventListener('click', event => {
        if (event.target === $('#confirm-dialog')) $('#confirm-dialog').close('cancel');
      });
    }
  }

  init();
})();
