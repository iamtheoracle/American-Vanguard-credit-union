// Shared formatting, feedback, and confirmation helpers.
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = cents => currency.format((Number(cents) || 0) / 100);

export function dollarsToCents(value) {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!raw) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const cents = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function centsToInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export function shortDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return `Today · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fullDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

export function dateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function statusLabel(status) {
  return String(status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function statusTone(status) {
  if (['posted', 'completed', 'paid', 'active', 'verified', 'approved', 'succeeded', 'matured'].includes(status)) return 'good';
  if (['pending', 'pending_approval', 'pending_review', 'in_progress', 'info_requested', 'escalated', 'scheduled'].includes(status)) return 'warn';
  if (['rejected', 'failed', 'declined', 'cancelled', 'expired', 'reversed', 'reversed'].includes(status)) return 'bad';
  return 'neutral';
}

export function badge(status) {
  return `<span class="status-badge status-${statusTone(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'AV';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

let toastTimer = null;
export function toast(message, type = 'success') {
  const region = $('#toast-region');
  if (!region) return;
  const element = document.createElement('div');
  element.className = `toast${type === 'error' ? ' error' : ''}`;
  element.textContent = message;
  region.append(element);
  $('#live-announcer').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.remove(), 4800);
}

export function announce(message) {
  const region = $('#live-announcer');
  if (region) region.textContent = message;
}

export function setError(element, message) {
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

export function setBusy(button, busy, busyText = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

// Modal confirmation. Resolves true only when the user confirms.
export function confirmAction({ title, description, summary = '', confirmText = 'Confirm', danger = false }) {
  const dialog = $('#confirm-dialog');
  if (!dialog) return Promise.resolve(window.confirm(`${title}\n\n${description}`));
  return new Promise(resolve => {
    $('#dialog-title').textContent = title;
    $('#dialog-description').textContent = description;
    $('#dialog-summary').innerHTML = summary;
    const confirmButton = $('#dialog-confirm');
    confirmButton.textContent = confirmText;
    confirmButton.classList.toggle('danger-solid', danger);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      dialog.close();
      resolve(value);
    };
    const onClose = () => finish(dialog.returnValue === 'confirm');
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}
