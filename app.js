(() => {
  'use strict';

  const STORAGE_KEY = 'avcu.member.v1';
  const MAX_TRANSACTIONS = 100;
  const accounts = {
    draft: { name: 'Share Draft (Checking)', suffix: '2048', kind: 'EVERYDAY' },
    primary: { name: 'Primary Share (Savings)', suffix: '3812', kind: 'SAVINGS' },
    market: { name: 'Money Market', suffix: '6621', kind: 'GROWTH' },
    holiday: { name: 'Holiday Club', suffix: '9055', kind: 'GOAL SAVINGS' },
    business: { name: 'Business Operating Account', suffix: '7314', kind: 'BUSINESS' },
    ira: { name: 'Traditional IRA', suffix: '4472', kind: 'RETIREMENT' },
    certificate: { name: 'Share Certificate', suffix: '1189', kind: 'TERM SAVINGS' },
    retirement401k: { name: '401(k) Retirement', suffix: '401K', kind: 'RETIREMENT' }
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
      // Migrate older local demo saves without discarding balances or history.
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
    if (Number.isNaN(date.getTime())) return 'Demo activity';
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
    if (!['home', 'move', 'deposit', 'card', 'operations', 'more'].includes(view)) return;
    currentView = view;
    $$('.page-view').forEach(el => el.classList.toggle('hidden', el.dataset.view !== view));
    $$('[data-nav]').forEach(button => {
      const active = button.dataset.nav === view;
      button.classList.toggle('active', active);
      if (button.matches('button')) button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const copy = {
      home: ['MEMBER OVERVIEW', 'Welcome to AVCU'],
      move: ['MOVE MONEY', 'Move money'],
      deposit: ['DEPOSIT', 'Deposit a sample check'],
      card: ['CARD CONTROLS', 'Your debit card'],
      operations: ['PAYMENT WORKSPACE', 'Payments & approvals'],
      more: ['MEMBER RESOURCES', 'More from AVCU']
    }[view];
    $('#top-eyebrow').textContent = copy[0];
    $('#page-title').textContent = copy[1];
    if (view === 'move') renderMoveBalances();
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
    $('#total-balance').textContent = money(total());
    $$('[data-balance]').forEach(el => {
      const account = el.dataset.balance;
      if (accounts[account]) el.textContent = money(state.balances[account]);
    });
    const recent = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 4);
    $('#recent-transactions').innerHTML = recent.length ? recent.map(transactionMarkup).join('') : '<p class="empty-state">No account activity yet. Start a payment or deposit request.</p>';
    $('#card-status-dot').classList.toggle('frozen', state.frozen);
    $('#card-status-text').textContent = state.frozen ? 'Card is frozen' : 'Card is active';
    $('#today-label').textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    $('#ledger-count').textContent = String(state.transactions.length);
    $('#ledger-card-status').textContent = state.frozen ? 'Frozen' : 'Not connected';
  }

  function renderMoveBalances() {
    $('#move-balances').innerHTML = Object.keys(accounts).map(key =>
      `<div class="balance-list-row"><span>${escapeHtml(accounts[key].name)}</span><strong>${money(state.balances[key])}</strong></div>`
    ).join('');
    updateTransferMode();
  }

  function renderAllTransactions() {
    const rows = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
    $('#all-transactions').innerHTML = rows.length ? rows.map(transactionMarkup).join('') : '<p class="empty-state">No activity in the demo ledger yet.</p>';
    $('#ledger-count').textContent = String(state.transactions.length);
    $('#ledger-card-status').textContent = state.frozen ? 'Frozen' : 'Active';
  }

  function renderCard() {
    $('#freeze-overlay').classList.toggle('hidden', !state.frozen);
    $('#large-demo-card').setAttribute('aria-label', state.frozen ? 'Demo debit card, frozen' : 'Demo debit card, active');
    $('#card-state-indicator').classList.toggle('frozen', state.frozen);
    $('#card-state-heading').textContent = state.frozen ? 'Your card is frozen' : 'Your card is active';
    $('#card-state-description').textContent = state.frozen ? 'New purchase authorizations will be declined locally.' : 'Purchase authorizations can be recorded locally.';
    $('#freeze-toggle').textContent = state.frozen ? 'Unfreeze card' : 'Freeze card';
    $('#freeze-toggle').classList.toggle('danger-button', !state.frozen);
    $('#card-status-dot').classList.toggle('frozen', state.frozen);
    $('#card-status-text').textContent = state.frozen ? 'Card is frozen in this demo' : 'Card is active in this demo';
    $('#ledger-card-status').textContent = state.frozen ? 'Frozen' : 'Active';
  }

  function renderAll() {
    renderHome();
    renderMoveBalances();
    renderCard();
    if (currentView === 'more') renderAllTransactions();
  }

  window.renderAll = renderAll;

  function addTransaction(account, title, amount, detail) {
    state.transactions.unshift({ id: createId(), account, title, amount, date: new Date().toISOString(), detail });
    state.transactions = state.transactions.slice(0, MAX_TRANSACTIONS);
  }

  function showConfirm({ title, description, summary, confirmText = 'Confirm demo action', onConfirm }) {
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

  function submitTransfer(form) {
    const data = new FormData(form);
    const kind = data.get('kind') || 'share';
    if (!['share', 'bill'].includes(kind)) { showToast('Choose a supported demo action.', 'error'); return; }
    const from = kind === 'bill' ? 'draft' : String(data.get('from'));
    const to = String(data.get('to'));
    const amount = Number(data.get('amount'));
    const memo = String(data.get('memo') || '').trim();
    const payee = String(data.get('payee') || '').trim();
    if (!accounts[from] || (kind === 'share' && (!accounts[to] || to === from))) {
      showToast('Choose two different accounts for a transfer.', 'error');
      return;
    }
    if (!safeMoneyInput(amount) || !Number.isSafeInteger(cents(amount))) {
      showToast('Enter a valid amount with no more than two decimal places.', 'error');
      return;
    }
    const amountCents = cents(amount);
    if (state.balances[from] < amountCents) {
      showToast(`Not enough available funds in ${accounts[from].name} for this request.`, 'error');
      return;
    }
    if (kind === 'bill' && (!payee || payee.length > 80)) {
      showToast('Enter a biller or payee name.', 'error');
      $('#bill-payee').focus();
      return;
    }
    const title = kind === 'bill' ? `Bill payment · ${payee}` : 'Account transfer';
    const destination = kind === 'share' ? accounts[to].name : payee;
    showConfirm({
      title: kind === 'bill' ? 'Review bill payment request' : 'Review account transfer request',
      description: 'This request will be routed for operator approval before any account posting. External payment execution requires a connected provider.',
      summary: `<div>From <strong>${escapeHtml(accounts[from].name)}</strong></div>${kind === 'share' ? `<div>To <strong>${escapeHtml(destination)}</strong></div>` : `<div>Payee <strong>${escapeHtml(payee)}</strong></div>`}<div>Amount <strong>${money(amountCents)}</strong></div>${memo ? `<div>Memo <strong>${escapeHtml(memo)}</strong></div>` : ''}`,
      confirmText: 'Submit for approval',
      onConfirm: () => {
        if (state.balances[from] < amountCents) {
          showToast('The available demo balance changed. Review the transfer again.', 'error');
          return;
        }
        state.balances[from] -= amountCents;
        addTransaction(from, title, -amountCents, kind === 'bill' ? 'Bill payment' : 'Share transfer');
        if (kind === 'share') {
          state.balances[to] += amountCents;
          addTransaction(to, 'Transfer received', amountCents, 'Share transfer');
        }
        saveState();
        renderAll();
        form.reset();
        $('#transfer-kind').value = 'share';
        $('#transfer-from').disabled = false;
        $('#transfer-to').value = 'primary';
        updateTransferMode();
        showToast(kind === 'bill' ? 'Bill payment request recorded.' : 'Account transfer request recorded.');
      }
    });
  }

  function submitDeposit(form) {
    const data = new FormData(form);
    const account = String(data.get('account'));
    const amount = Number(data.get('amount'));
    const description = String(data.get('description') || '').trim();
    if (!accounts[account] || !safeMoneyInput(amount) || amount > 100000 || !Number.isSafeInteger(cents(amount))) {
      showToast('Choose a share and enter a valid positive check amount.', 'error');
      return;
    }
    if (!description || description.length > 80) {
      showToast('Enter a deposit description.', 'error');
      return;
    }
    const amountCents = cents(amount);
    showConfirm({
      title: 'Submit check deposit request?',
      description: 'This request will enter the review queue. The check must be captured and processed by an authorized deposit service before funds are posted.',
      summary: `<div>Share <strong>${escapeHtml(accounts[account].name)}</strong></div><div>Description <strong>${escapeHtml(description)}</strong></div><div>Deposit <strong>+${money(amountCents)}</strong></div>`,
      confirmText: 'Submit for approval',
      onConfirm: () => {
        state.balances[account] += amountCents;
        addTransaction(account, description, amountCents, 'Sample check deposit');
        saveState();
        renderAll();
        form.reset();
        $('#deposit-description').value = 'Sample check deposit';
        $('#check-preview-amount').textContent = '$0.00';
        showToast('Check deposit request submitted for approval.');
      }
    });
  }

  function toggleFreeze() {
    const next = !state.frozen;
    showConfirm({
      title: next ? 'Freeze this card?' : 'Unfreeze this card?',
      description: next ? 'Simulated purchases will decline until you unfreeze the card.' : 'Simulated purchases can be approved again while the card is active.',
      summary: `<div>Card <strong>•••• 4826</strong></div><div>New status <strong>${next ? 'Frozen' : 'Active'}</strong></div>`,
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
    const amount = Number($('#purchase-amount').value);
    const merchant = String($('#purchase-merchant').value || '').trim();
    const result = $('#purchase-result');
    result.classList.remove('hidden', 'approved', 'declined');
    if (!safeMoneyInput(amount) || amount > 10000 || !Number.isSafeInteger(cents(amount)) || !merchant || merchant.length > 80) {
      result.classList.add('declined');
      result.textContent = 'Not processed: enter a valid amount and merchant name.';
      return;
    }
    const amountCents = cents(amount);
    if (state.frozen) {
      result.classList.add('declined');
      result.innerHTML = `<strong>DECLINED · CARD FROZEN</strong><br>The simulated ${money(amountCents)} purchase at ${escapeHtml(merchant)} was declined. No balance changed.`;
      showToast('Demo purchase declined because the card is frozen.', 'error');
    } else if (state.balances.draft < amountCents) {
      result.classList.add('declined');
      result.innerHTML = `<strong>DECLINED · INSUFFICIENT FUNDS</strong><br>The simulated ${money(amountCents)} purchase at ${escapeHtml(merchant)} exceeds the available Share Draft balance of ${money(state.balances.draft)}. No balance changed.`;
      showToast('Demo purchase declined: insufficient Share Draft funds.', 'error');
    } else {
      state.balances.draft -= amountCents;
      addTransaction('draft', merchant, -amountCents, 'Card purchase');
      saveState();
      renderAll();
      result.classList.add('approved');
      result.innerHTML = `<strong>APPROVED · DEMO ONLY</strong><br>The simulated ${money(amountCents)} purchase at ${escapeHtml(merchant)} was approved. Share Draft was reduced by ${money(amountCents)} and the demo ledger was updated.`;
      showToast('Demo purchase approved and recorded in the local sample ledger.');
    }
    announce(result.textContent);
  }

  function resetDemo() {
    showConfirm({
      title: 'Reset local account workspace?',
      description: 'This clears locally stored account records and restores empty account balances on this device. It does not change records held by any financial institution.',
      summary: '<div>Accounts <strong>8 local account records</strong></div><div>Activity <strong>Local transaction history</strong></div><div>Card <strong>Active</strong></div>',
      confirmText: 'Reset local records',
      onConfirm: () => {
        state = cloneSeed();
        saveState();
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
    $('#reset-demo').addEventListener('click', resetDemo);
    $('#help-button').addEventListener('click', showHelp);
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
