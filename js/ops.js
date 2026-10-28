import { api } from './api.js';
import {
  $, $$, money, dollarsToCents, escapeHtml, shortDate, fullDateTime, statusLabel,
  statusTone, badge, initials, toast, setBusy, announce, dateInputValue
} from './ui.js';

const VIEWS = {
  queue: ['OPERATIONS', 'Dashboard'],
  approvals: ['DECISION QUEUE', 'Approvals'],
  members: ['MEMBERSHIP', 'Members'],
  cases: ['SUPPORT', 'Support cases'],
  transactions: ['LEDGER', 'Transactions'],
  imports: ['HISTORICAL DATA', 'History import'],
  lending: ['LENDING', 'Lending & deposits'],
  ai: ['ASSISTANT', 'AI tasks'],
  audit: ['GOVERNANCE', 'Audit log'],
  team: ['ACCESS', 'Operators'],
  integrations: ['INTEGRATIONS', 'Provider readiness']
};

const state = { operator: null, view: 'queue', activeCaseId: null, approvals: [] };

const canManage = () => ['management', 'super_admin'].includes(state.operator?.role);

// ---------------------------------------------------------------- auth
async function boot() {
  bindEvents();
  try {
    const result = await api('/auth/operator/me');
    startApp(result.operator);
  } catch {
    $('#ops-auth').classList.remove('hidden');
    $('#ops-email').focus();
  }
}

function startApp(operator) {
  state.operator = operator;
  $('#ops-auth').classList.add('hidden');
  $('#ops-app').classList.remove('hidden');
  $('#ops-name').textContent = operator.name;
  $('#ops-role').textContent = statusLabel(operator.role);
  $('#ops-avatar').textContent = initials(operator.name);
  if (operator.role !== 'super_admin') {
    $$('[data-ops-view="team"]').forEach(button => button.classList.add('hidden'));
  }
  if (!canManage()) $$('#historical-form, #import-form').forEach(form => form?.classList.add('hidden'));
  setView('queue');
}

async function logout() {
  try { await api('/operator/logout', { method: 'POST' }); } catch { /* already gone */ }
  location.reload();
}

// ---------------------------------------------------------------- navigation
const loaded = new Set();
async function setView(view) {
  if (!VIEWS[view]) return;
  state.view = view;
  $$('[data-ops-section]').forEach(section => section.classList.toggle('hidden', section.dataset.opsSection !== view));
  $$('[data-ops-view]').forEach(button => button.classList.toggle('active', button.dataset.opsView === view));
  $('#ops-eyebrow').textContent = VIEWS[view][0];
  $('#ops-title').textContent = VIEWS[view][1];
  if (view === 'queue' || !loaded.has(view)) {
    loaded.add(view);
    try {
      await LOADERS[view]?.();
    } catch (error) {
      toast(error.message || 'Could not load this section.', 'error');
    }
  }
}

const LOADERS = {
  queue: renderDashboard,
  approvals: renderApprovals,
  members: renderMembers,
  cases: renderCases,
  transactions: renderTransactions,
  imports: renderImports,
  lending: renderLending,
  ai: renderAiTasks,
  audit: renderAudit,
  team: renderTeam,
  integrations: renderIntegrations
};

// ---------------------------------------------------------------- dashboard
async function renderDashboard() {
  const queue = await api('/operator/queue');
  const stats = [
    ['Approvals pending', queue.approvals.pending, 'approvals'],
    ['Escalated', queue.approvals.escalated, 'approvals'],
    ['Membership pending', queue.membershipPending, 'approvals'],
    ['Support open', queue.cases.open, 'cases'],
    ['Pending transactions', queue.transactionsPending, 'transactions'],
    ['Loan applications', queue.loansPending, 'approvals'],
    ['Money requests', queue.requestsPending, 'lending'],
    ['Failed AI tasks', queue.aiFailed, 'ai']
  ];
  $('#ops-stats').innerHTML = stats.map(([label, value, target]) => `
    <button class="stat-card" data-ops-view="${target}">
      <span>${escapeHtml(label)}</span><strong>${Number(value).toLocaleString('en-US')}</strong>
      <small>Open queue →</small>
    </button>`).join('');
  state.health = queue.integrations;
  renderHealth($('#ops-health'), queue.integrations);
}

function renderHealth(container, integrations) {
  if (!container) return;
  container.innerHTML = integrations.map(item => `
    <article class="health-card health-${escapeHtml(item.status)}">
      <div class="health-head"><strong>${escapeHtml(item.name)}</strong>${badge(item.status)}</div>
      <p class="muted">Adapter: ${escapeHtml(item.adapter)} · Circuit: ${escapeHtml(item.circuit)}</p>
      <small>${escapeHtml(JSON.stringify(item.detail || {}))}</small>
    </article>`).join('');
}

// ---------------------------------------------------------------- approvals
async function renderApprovals() {
  const status = $('#approval-status').value;
  const result = await api(`/operator/approvals?status=${encodeURIComponent(status)}`);
  state.approvals = result.approvals;
  $('#approvals-list').innerHTML = result.approvals.length ? result.approvals.map(item => {
    const payload = item.payload || {};
    const amount = item.amountCents || payload.principalCents || payload.amountCents;
    const detail = item.itemType === 'membership'
      ? `${escapeHtml(item.memberName || payload.fullName || '')} · ${escapeHtml(item.memberEmail || payload.email || '')}`
      : `${escapeHtml(item.memberName || '')} · ${escapeHtml(statusLabel(payload.type || payload.product || item.transactionType || ''))}
         ${amount ? `· ${money(amount)}` : ''} ${item.reference ? `· ${escapeHtml(item.reference)}` : payload.reference ? `· ${escapeHtml(payload.reference)}` : ''}`;
    const actions = ['pending', 'escalated', 'info_requested'].includes(item.status) ? `
      <div class="decision-actions">
        <button class="primary-button small" data-decide="approve" data-approval="${item.id}">Approve</button>
        <button class="secondary-button small" data-decide="reject" data-approval="${item.id}">Reject</button>
        <button class="secondary-button small" data-decide="escalate" data-approval="${item.id}">Escalate</button>
        <button class="secondary-button small" data-decide="request_info" data-approval="${item.id}">Request info</button>
      </div>` : '';
    return `<article class="queue-item">
      <div class="queue-head">
        <div><p class="eyebrow">${escapeHtml(statusLabel(item.itemType))} · ${escapeHtml(statusLabel(item.requiredRole))}</p>
        <h3>${escapeHtml(detail)}</h3>
        <small>Submitted ${escapeHtml(fullDateTime(item.createdAt))}${item.decidedAt ? ` · decided ${escapeHtml(fullDateTime(item.decidedAt))}` : ''}</small></div>
        ${badge(item.status)}
      </div>
      ${item.decisionReason ? `<p class="muted">Decision note: ${escapeHtml(item.decisionReason)}</p>` : ''}
      ${item.infoRequested ? `<p class="muted">Info requested: ${escapeHtml(item.infoRequested)}</p>` : ''}
      ${actions}
    </article>`;
  }).join('') : '<p class="empty-state">Nothing in this queue.</p>';
}

function askDecision({ title, description, summary, confirmText }) {
  const dialog = $('#decision-dialog');
  return new Promise(resolve => {
    $('#decision-title').textContent = title;
    $('#decision-description').textContent = description;
    $('#decision-summary').innerHTML = summary || '';
    $('#decision-reason').value = '';
    $('#decision-confirm').textContent = confirmText;
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm' ? { ok: true, reason: $('#decision-reason').value.trim() } : { ok: false });
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    $('#decision-reason').focus();
  });
}

async function decideApproval(id, action) {
  const approval = state.approvals.find(item => item.id === id);
  const labels = {
    approve: ['Approve this item?', 'Approving executes the stored movement or decision.', 'Approve'],
    reject: ['Reject this item?', 'A written reason is required and is shown to the member.', 'Reject'],
    escalate: ['Escalate this item?', 'Escalating requires a super admin decision.', 'Escalate'],
    request_info: ['Request more information?', 'Describe what the member needs to provide.', 'Request info']
  };
  const [title, description, confirmText] = labels[action];
  const answer = await askDecision({
    title, description, confirmText,
    summary: approval
      ? `<div>Member <strong>${escapeHtml(approval.memberName || approval.payload?.fullName || '—')}</strong></div>
         <div>Item <strong>${escapeHtml(statusLabel(approval.itemType))}</strong></div>
         ${approval.amountCents || approval.payload?.principalCents
          ? `<div>Amount <strong>${money(approval.amountCents || approval.payload.principalCents)}</strong></div>` : ''}`
      : ''
  });
  if (!answer.ok) return;
  if (action === 'reject' && !answer.reason) {
    toast('A written reason is required to reject.', 'error');
    return;
  }
  try {
    const result = await api(`/operator/approvals/${id}/decide`, {
      method: 'POST', body: { action, reason: answer.reason || undefined }
    });
    toast(`Decision recorded: ${result.approval.status}.`);
    await renderApprovals();
    loaded.delete('queue');
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- members
async function renderMembers(search = $('#member-search')?.value?.trim() || '') {
  const result = await api(`/operator/members?search=${encodeURIComponent(search)}`);
  $('#members-list').innerHTML = result.members.length ? result.members.map(member => `
    <button class="queue-item queue-item-button" data-member-id="${member.id}">
      <div class="queue-head">
        <div><p class="eyebrow">${escapeHtml(member.memberNumber || '')} · @${escapeHtml(member.username || '')}</p>
        <h3>${escapeHtml(member.fullName)}</h3>
        <small>${escapeHtml(member.email)} · joined ${escapeHtml(shortDate(member.createdAt))} · ${member.emailVerified ? 'email verified' : 'email unverified'}</small></div>
        <div class="queue-right">${badge(member.status)}<strong>${money(member.totalCents)}</strong></div>
      </div>
    </button>`).join('') : '<p class="empty-state">No members match that search.</p>';
}

async function openMember(memberId) {
  const result = await api(`/operator/members/${memberId}`);
  $('#member-detail-panel').hidden = false;
  $('#member-detail-eyebrow').textContent = `MEMBER ${result.member.memberNumber}`;
  $('#member-detail-title').textContent = result.member.fullName;
  $('#member-detail').innerHTML = `
    <dl class="identity-list">
      <div><dt>Username</dt><dd>@${escapeHtml(result.member.username)}</dd></div>
      <div><dt>Email</dt><dd>${escapeHtml(result.member.email)}</dd></div>
      <div><dt>Status</dt><dd>${escapeHtml(statusLabel(result.member.status))}</dd></div>
      <div><dt>Email verified</dt><dd>${result.member.emailVerified ? 'Yes' : 'No'}</dd></div>
      <div><dt>Phone</dt><dd>${escapeHtml(result.member.phone || '—')}</dd></div>
      <div><dt>Address</dt><dd>${escapeHtml(result.member.mailingAddress || '—')}</dd></div>
      <div><dt>Last login</dt><dd>${escapeHtml(fullDateTime(result.member.lastLoginAt))}</dd></div>
    </dl>
    <h3 class="section-subhead">Accounts</h3>
    <div class="statement-list">${result.accounts.length ? result.accounts.map(account => `
      <div class="statement-row"><div><strong>${escapeHtml(account.name)} · ${money(account.balanceCents)}</strong>
      <small>${escapeHtml(account.accountNumber)} · routing ${escapeHtml(account.routingNumber)} · ${escapeHtml(statusLabel(account.status))}</small></div>${badge(account.status)}</div>`).join('')
      : '<p class="empty-state">No accounts.</p>'}</div>
    <h3 class="section-subhead">Recent transactions</h3>
    <div class="statement-list">${result.transactions.length ? result.transactions.map(txn => `
      <div class="statement-row"><div><strong>${escapeHtml(txn.description || txn.memo || txn.payee || statusLabel(txn.type))} · ${money(txn.amountCents)}</strong>
      <small>${escapeHtml(fullDateTime(txn.occurredAt))} · ${escapeHtml(txn.reference)}${txn.externalReference ? ` · ext ${escapeHtml(txn.externalReference)}` : ''}</small></div>${badge(txn.status)}</div>`).join('')
      : '<p class="empty-state">No transactions.</p>'}</div>
    <h3 class="section-subhead">Loans &amp; certificates</h3>
    <div class="statement-list">${result.loans.length || result.certificates.length
      ? [...result.loans.map(loan => `<div class="statement-row"><div><strong>Loan ${escapeHtml(loan.reference)} · ${money(loan.balanceCents)}</strong><small>${escapeHtml(statusLabel(loan.status))}</small></div></div>`),
        ...result.certificates.map(cert => `<div class="statement-row"><div><strong>Certificate ${money(cert.amountCents)} · ${cert.termMonths}mo</strong><small>${escapeHtml(statusLabel(cert.status))}</small></div></div>`)
      ].join('') : '<p class="empty-state">None.</p>'}</div>`;
  $('#member-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- support
async function renderCases() {
  const result = await api('/operator/cases');
  $('#ops-cases').innerHTML = result.cases.length ? result.cases.map(item => `
    <button class="queue-item queue-item-button" data-ops-case="${item.id}">
      <div class="queue-head"><div><p class="eyebrow">${escapeHtml(item.memberName)} · ${escapeHtml(item.memberEmail)}</p>
      <h3>${escapeHtml(item.subject)}</h3><small>Opened ${escapeHtml(shortDate(item.createdAt))}</small></div>
      <div class="queue-right">${badge(item.status)}${item.priority === 'high' ? '<span class="status-badge status-warn">High</span>' : ''}</div></div>
    </button>`).join('') : '<p class="empty-state">No support cases.</p>';
}

async function openCase(caseId) {
  const result = await api(`/operator/cases/${caseId}`);
  state.activeCaseId = caseId;
  $('#ops-case-panel').hidden = false;
  $('#ops-case-eyebrow').textContent = `${statusLabel(result.case.status).toUpperCase()} · ${result.case.memberName}`;
  $('#ops-case-title').textContent = result.case.subject;
  $('#ops-case-thread').innerHTML = result.messages.length ? result.messages.map(message => `
    <div class="case-message case-${message.authorType}">
      <span class="case-author">${message.authorType === 'operator' ? 'Operator' : escapeHtml(result.case.memberName)}</span>
      <p>${escapeHtml(message.body)}</p><small>${escapeHtml(fullDateTime(message.createdAt))}</small>
    </div>`).join('') : '<p class="empty-state">No messages.</p>';
  $('#ops-case-actions').innerHTML = `
    <button class="secondary-button small" data-case-status="in_progress">Mark in progress</button>
    <button class="secondary-button small" data-case-status="escalated">Escalate</button>
    <button class="primary-button small" data-case-status="resolved">Resolve</button>`;
  $('#ops-case-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- transactions
async function renderTransactions() {
  const search = $('#txn-search').value.trim();
  const status = $('#txn-status').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  const result = await api(`/operator/transactions?${params.toString()}`);
  const rows = result.transactions;
  const pending = rows.filter(txn => ['pending_approval', 'pending_review'].includes(txn.status));
  $('#pending-transactions').innerHTML = pending.length ? pending.map(txn => `
    <div class="queue-item">
      <div class="queue-head"><div><p class="eyebrow">${escapeHtml(txn.memberName)} · ${escapeHtml(statusLabel(txn.type))}</p>
      <h3>${money(txn.amountCents)} · ${escapeHtml(txn.description || txn.memo || txn.payee || '')}</h3>
      <small>${escapeHtml(fullDateTime(txn.occurredAt))} · ${escapeHtml(txn.reference)}</small></div>${badge(txn.status)}</div>
      ${canManage() ? `<div class="decision-actions">
        <button class="primary-button small" data-process="post" data-txn="${txn.id}">Post</button>
        <button class="secondary-button small" data-process="reject" data-txn="${txn.id}">Reject</button>
      </div>` : '<p class="muted">Management can process pending items.</p>'}
    </div>`).join('') : '<p class="empty-state">No pending transactions.</p>';

  $('#ops-transactions').innerHTML = rows.length ? rows.map(txn => `
    <div class="queue-item">
      <div class="queue-head"><div>
        <p class="eyebrow">${escapeHtml(txn.memberName)} · ${escapeHtml(txn.username || txn.memberNumber || '')} · ${escapeHtml(statusLabel(txn.type))}</p>
        <h3>${money(txn.amountCents)} · ${escapeHtml(txn.description || txn.memo || txn.payee || '')}</h3>
        <small>${escapeHtml(fullDateTime(txn.occurredAt))} · ${escapeHtml(txn.reference)}
        ${txn.externalReference ? ` · ext ${escapeHtml(txn.externalReference)}` : ''} · ${escapeHtml(txn.source)}</small>
      </div>${badge(txn.status)}</div>
      ${txn.decisionReason ? `<p class="muted">Note: ${escapeHtml(txn.decisionReason)}</p>` : ''}
    </div>`).join('') : '<p class="empty-state">No transactions match.</p>';
}

async function processTransaction(id, action) {
  const answer = await askDecision({
    title: action === 'post' ? 'Post this pending transaction?' : 'Reject this pending transaction?',
    description: action === 'post'
      ? 'Posting applies the movement to the ledger with its original date.'
      : 'Rejecting cancels the movement. A written reason is required.',
    confirmText: action === 'post' ? 'Post transaction' : 'Reject transaction'
  });
  if (!answer.ok) return;
  if (action === 'reject' && !answer.reason) { toast('A reason is required.', 'error'); return; }
  try {
    await api(`/operator/transactions/${id}/process`, { method: 'POST', body: { action, reason: answer.reason } });
    toast(action === 'post' ? 'Transaction posted.' : 'Transaction rejected.');
    await renderTransactions();
    loaded.delete('queue');
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- imports
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], error: 'No rows found.' };
  const split = line => {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
        else quoted = !quoted;
      } else if (char === ',' && !quoted) { out.push(current); current = ''; }
      else current += char;
    }
    out.push(current);
    return out.map(cell => cell.trim());
  };
  const header = split(lines[0]).map(cell => cell.toLowerCase());
  const hasHeader = header.includes('member') && header.includes('account');
  const columns = hasHeader
    ? header
    : ['member', 'account', 'date', 'type', 'amount', 'status', 'reference', 'description'];
  const body = hasHeader ? lines.slice(1) : lines;
  const rows = [];
  for (let index = 0; index < body.length; index += 1) {
    const cells = split(body[index]);
    const record = {};
    for (let i = 0; i < columns.length; i += 1) record[columns[i]] = cells[i] ?? '';
    const amountRaw = String(record.amount || '').replace(/[$,]/g, '');
    const amountCents = Math.round(Number(amountRaw) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return { rows: [], error: `Row ${index + 1}: amount must be a positive number.` };
    }
    rows.push({
      memberIdentifier: record.member,
      accountNumber: record.account,
      occurredAt: record.date,
      type: record.type,
      amountCents,
      status: record.status || 'posted',
      externalReference: record.reference || null,
      description: record.description || record.memo || ''
    });
  }
  return { rows };
}

async function renderImports() {
  const result = await api('/operator/imports');
  $('#imports-list').innerHTML = result.batches.length ? result.batches.map(batch => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(batch.createdBy || '')}</p>
      <h3>${escapeHtml(batch.filename || 'Pasted rows')} · ${batch.rowCount} rows</h3>
      <small>${batch.postedCount} posted · ${batch.skippedCount} recorded without posting · ${money(batch.totalCents)} total · ${escapeHtml(fullDateTime(batch.createdAt))}</small>
    </div>${badge(batch.status)}</div></div>`).join('') : '<p class="empty-state">No imports yet.</p>';
}

// ---------------------------------------------------------------- lending
async function renderLending() {
  const [loans, investments, requests] = await Promise.all([
    api('/operator/loans'), api('/operator/investments'), api('/operator/requests')
  ]);
  $('#ops-loans').innerHTML = loans.loans.length ? loans.loans.map(loan => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(loan.memberName)} · @${escapeHtml(loan.username || '')}</p>
      <h3>${escapeHtml(loan.reference)} · ${money(loan.principalCents)} ${escapeHtml(statusLabel(loan.product))}</h3>
      <small>Balance ${money(loan.balanceCents)} · ${loan.aprBps / 100}% APR* · ${loan.termMonths} months${loan.nextDueDate ? ` · next due ${escapeHtml(shortDate(loan.nextDueDate))}` : ''}</small>
    </div>${badge(loan.status)}</div></div>`).join('') : '<p class="empty-state">No loans.</p>';
  $('#ops-investments').innerHTML = investments.commitments.length ? investments.commitments.map(cert => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(cert.memberName)} · ${escapeHtml(cert.accountNumber)}</p>
      <h3>${money(cert.amountCents)} · ${cert.termMonths} months · ${(cert.apyBps / 100).toFixed(2)}% APY*</h3>
      <small>Opened ${escapeHtml(shortDate(cert.openedAt))} · matures ${escapeHtml(shortDate(cert.maturesAt))}</small>
    </div>${badge(cert.status)}</div></div>`).join('') : '<p class="empty-state">No certificate commitments.</p>';
  $('#ops-requests').innerHTML = requests.requests.length ? requests.requests.map(request => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(request.requesterName)} → ${escapeHtml(request.payerName || request.payerEmail || '')}</p>
      <h3>${money(request.amountCents)} · ${escapeHtml(request.memo || 'No memo')}</h3>
      <small>${escapeHtml(fullDateTime(request.createdAt))}</small>
    </div>${badge(request.status)}</div></div>`).join('') : '<p class="empty-state">No requests.</p>';
}

// ---------------------------------------------------------------- AI tasks
async function renderAiTasks() {
  const status = $('#ai-status').value;
  const result = await api(`/operator/ai-tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  $('#ai-tasks').innerHTML = result.tasks.length ? result.tasks.map(task => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(task.requesterType)} · ${escapeHtml(task.purpose)} · ${escapeHtml(task.provider)}</p>
      <h3>${escapeHtml(task.inputExcerpt || 'No input excerpt')}</h3>
      <small>${escapeHtml(fullDateTime(task.createdAt))}${task.error ? ` · ${escapeHtml(task.error)}` : ''}</small>
    </div>${badge(task.status)}</div>
    ${task.status === 'failed' ? '<p class="muted">Manual fallback: contact the member and handle the request with an authorized workflow.</p>' : ''}
    </div>`).join('') : '<p class="empty-state">No AI tasks.</p>';
}

// ---------------------------------------------------------------- audit
async function renderAudit() {
  const result = await api('/operator/audit?limit=200');
  $('#audit-list').innerHTML = result.events.map(event => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(event.actorType)} ${event.actorRole ? `· ${escapeHtml(event.actorRole)}` : ''}</p>
      <h3>${escapeHtml(event.action)}</h3>
      <small>${escapeHtml(event.entityType)} ${escapeHtml(event.entityId || '')} · ${escapeHtml(fullDateTime(event.createdAt))}</small>
      <small class="reference-line">${escapeHtml(JSON.stringify(event.metadata || {}))}</small>
    </div></div></div>`).join('');
}

// ---------------------------------------------------------------- team
async function renderTeam() {
  const result = await api('/operator/operators');
  $('#operators-list').innerHTML = result.operators.map(operator => `
    <div class="queue-item"><div class="queue-head"><div>
      <p class="eyebrow">${escapeHtml(operator.email)}</p>
      <h3>${escapeHtml(operator.name)}</h3>
      <small>${escapeHtml(statusLabel(operator.role))} · ${operator.active ? 'Active' : 'Inactive'} · created ${escapeHtml(shortDate(operator.createdAt))}</small>
    </div>
    ${operator.active ? badge('active') : badge('cancelled')}</div>
    <div class="decision-actions">
      <select data-role-select="${operator.id}">
        ${['operator', 'management', 'super_admin'].map(role => `<option value="${role}" ${role === operator.role ? 'selected' : ''}>${statusLabel(role)}</option>`).join('')}
      </select>
      <button class="secondary-button small" data-save-role="${operator.id}">Save role</button>
      <button class="secondary-button small" data-toggle-active="${operator.id}" data-active="${operator.active}">${operator.active ? 'Deactivate' : 'Reactivate'}</button>
    </div></div>`).join('');
}

// ---------------------------------------------------------------- integrations
async function renderIntegrations() {
  const result = await api('/operator/integrations');
  renderHealth($('#integration-cards'), result.integrations);
}

// ---------------------------------------------------------------- events
function bindEvents() {
  $('#ops-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const errorBox = $('#ops-login-error');
    errorBox.hidden = true;
    setBusy(button, true, 'Signing in…');
    try {
      const result = await api('/operator/login', {
        method: 'POST', body: { email: $('#ops-email').value.trim(), password: $('#ops-password').value }
      });
      form.reset();
      startApp(result.operator);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      setBusy(button, false);
    }
  });

  document.addEventListener('click', async event => {
    const nav = event.target.closest('[data-ops-view]');
    if (nav) { event.preventDefault(); await setView(nav.dataset.opsView); return; }
    if (event.target.closest('#ops-logout')) { await logout(); return; }

    const decide = event.target.closest('[data-decide]');
    if (decide) { await decideApproval(decide.dataset.approval, decide.dataset.decide); return; }

    const member = event.target.closest('[data-member-id]');
    if (member) { await openMember(member.dataset.memberId).catch(error => toast(error.message, 'error')); return; }
    if (event.target.closest('#member-detail-close')) { $('#member-detail-panel').hidden = true; return; }

    const caseRow = event.target.closest('[data-ops-case]');
    if (caseRow) { await openCase(caseRow.dataset.opsCase).catch(error => toast(error.message, 'error')); return; }
    if (event.target.closest('#ops-case-close')) { $('#ops-case-panel').hidden = true; return; }
    const caseStatus = event.target.closest('[data-case-status]');
    if (caseStatus) {
      try {
        await api(`/operator/cases/${state.activeCaseId}/status`, {
          method: 'POST', body: { status: caseStatus.dataset.caseStatus }
        });
        toast(`Case ${statusLabel(caseStatus.dataset.caseStatus).toLowerCase()}.`);
        await openCase(state.activeCaseId);
        loaded.delete('cases');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }

    const process = event.target.closest('[data-process]');
    if (process) { await processTransaction(process.dataset.txn, process.dataset.process); return; }

    const saveRole = event.target.closest('[data-save-role]');
    if (saveRole) {
      const id = saveRole.dataset.saveRole;
      const role = $(`[data-role-select="${id}"]`).value;
      try {
        await api(`/operator/operators/${id}`, { method: 'PATCH', body: { role } });
        toast('Role updated.');
        await renderTeam();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    const toggleActive = event.target.closest('[data-toggle-active]');
    if (toggleActive) {
      const id = toggleActive.dataset.toggleActive;
      const active = toggleActive.dataset.active !== 'true';
      try {
        await api(`/operator/operators/${id}`, { method: 'PATCH', body: { active } });
        toast(active ? 'Operator reactivated.' : 'Operator deactivated.');
        await renderTeam();
      } catch (error) { toast(error.message, 'error'); }
    }
  });

  $('#approval-status').addEventListener('change', () => renderApprovals().catch(error => toast(error.message, 'error')));
  $('#approval-refresh').addEventListener('click', () => renderApprovals().catch(error => toast(error.message, 'error')));
  $('#member-search-form').addEventListener('submit', event => {
    event.preventDefault();
    renderMembers($('#member-search').value.trim()).catch(error => toast(error.message, 'error'));
  });
  $('#txn-filter').addEventListener('submit', event => {
    event.preventDefault();
    renderTransactions().catch(error => toast(error.message, 'error'));
  });
  $('#ai-status').addEventListener('change', () => renderAiTasks().catch(error => toast(error.message, 'error')));
  $('#ai-refresh').addEventListener('click', () => renderAiTasks().catch(error => toast(error.message, 'error')));

  $('#ops-case-reply').addEventListener('submit', async event => {
    event.preventDefault();
    const body = $('#ops-case-reply-input').value.trim();
    if (!body || !state.activeCaseId) return;
    try {
      await api(`/operator/cases/${state.activeCaseId}/messages`, { method: 'POST', body: { body } });
      $('#ops-case-reply-input').value = '';
      await openCase(state.activeCaseId);
    } catch (error) { toast(error.message, 'error'); }
  });

  $('#historical-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const amountCents = dollarsToCents($('#hist-amount').value);
    if (!amountCents) { toast('Enter a valid amount.', 'error'); return; }
    setBusy(button, true, 'Recording…');
    try {
      await api('/operator/transactions', {
        method: 'POST',
        body: {
          memberIdentifier: $('#hist-member').value.trim(),
          accountNumber: $('#hist-account').value.trim(),
          type: $('#hist-type').value,
          amountCents,
          occurredAt: $('#hist-date').value,
          status: $('#hist-status').value,
          externalReference: $('#hist-reference').value.trim() || null,
          description: $('#hist-description').value.trim()
        }
      });
      toast('Historical entry recorded with its original date.');
      form.reset();
      loaded.delete('transactions');
      await renderImports();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  $('#import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#import-text').value = await file.text();
    toast(`Loaded ${file.name}.`);
  });

  $('#import-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const parsed = parseCsv($('#import-text').value);
    if (parsed.error) { toast(parsed.error, 'error'); return; }
    if (!parsed.rows.length) { toast('No rows to import.', 'error'); return; }
    setBusy(button, true, `Importing ${parsed.rows.length}…`);
    try {
      const result = await api('/operator/imports', {
        method: 'POST', body: { rows: parsed.rows, filename: $('#import-file').files?.[0]?.name || null }
      });
      toast(`Batch committed: ${result.batch.postedCount} posted, ${result.batch.skippedCount} recorded only.`);
      form.reset();
      $('#import-text').value = '';
      loaded.delete('transactions');
      await renderImports();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  $('#operator-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    setBusy(button, true, 'Creating…');
    try {
      await api('/operator/operators', {
        method: 'POST',
        body: {
          name: $('#op-name').value.trim(),
          email: $('#op-email').value.trim(),
          role: $('#op-role').value,
          password: $('#op-password').value
        }
      });
      toast('Operator created.');
      form.reset();
      await renderTeam();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  const histDate = $('#hist-date');
  if (histDate) histDate.value = dateInputValue(new Date());
}

boot();
