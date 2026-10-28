import { api } from './api.js';
import { $, escapeHtml, toast } from './ui.js';

// Member AI assistant. The send control submits the form directly (click or
// Enter), the server owns tool execution, and failures offer retry plus a
// human handoff.
export function initAssistant({ onOpenSupport } = {}) {
  const panel = $('#assistant-panel');
  const form = $('#assistant-form');
  const input = $('#assistant-message');
  const messages = $('#assistant-messages');
  let busy = false;
  let lastFailedTaskId = null;

  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    $('#assistant-button')?.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  }

  function append(kind, html) {
    const bubble = document.createElement('div');
    bubble.className = `assistant-bubble assistant-bubble-${kind}`;
    bubble.innerHTML = html;
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  function appendFailure(message, taskId) {
    lastFailedTaskId = taskId || null;
    const bubble = append('bot assistant-bubble-error', `
      <strong>The assistant could not complete that.</strong>
      <p>${escapeHtml(message)}</p>
      <div class="assistant-actions">
        <button class="secondary-button small" data-retry-task="${taskId || ''}">Retry</button>
        <button class="secondary-button small" data-human-support="1">Talk to a person</button>
      </div>`);
    return bubble;
  }

  async function send(text) {
    busy = true;
    $('#assistant-form button[type="submit"]').disabled = true;
    append('user', escapeHtml(text));
    const thinking = append('bot assistant-bubble-pending', '<span class="typing-dots" aria-label="Assistant is thinking"><i></i><i></i><i></i></span>');
    try {
      const result = await api('/ai/chat', { method: 'POST', body: { message: text } });
      thinking.remove();
      if (result.status === 'failed') {
        appendFailure(result.message || 'The assistant is temporarily unavailable. Nothing changed.', result.taskId);
      } else {
        append('bot', escapeHtml(result.message || '').replace(/\n/g, '<br>'));
        lastFailedTaskId = null;
      }
    } catch (error) {
      thinking.remove();
      appendFailure(error.message || 'The assistant could not be reached. Nothing changed.', null);
      toast(error.message, 'error');
    } finally {
      busy = false;
      $('#assistant-form button[type="submit"]').disabled = false;
      input.focus();
    }
  }

  async function retry() {
    if (busy) return;
    if (!lastFailedTaskId) {
      append('bot', 'Please retype your request so it can be retried safely.');
      return;
    }
    busy = true;
    $('#assistant-form button[type="submit"]').disabled = true;
    const thinking = append('bot assistant-bubble-pending', '<span class="typing-dots" aria-label="Retrying"><i></i><i></i><i></i></span>');
    try {
      const result = await api('/ai/retry', { method: 'POST', body: { taskId: lastFailedTaskId } });
      thinking.remove();
      if (result.status === 'failed') appendFailure(result.message, result.taskId);
      else {
        append('bot', escapeHtml(result.message || '').replace(/\n/g, '<br>'));
        lastFailedTaskId = null;
      }
    } catch (error) {
      thinking.remove();
      appendFailure(error.message, null);
    } finally {
      busy = false;
      $('#assistant-form button[type="submit"]').disabled = false;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    send(text);
  });

  messages.addEventListener('click', event => {
    if (event.target.closest('[data-retry-task]')) { retry(); return; }
    if (event.target.closest('[data-human-support]')) {
      setOpen(false);
      onOpenSupport?.();
    }
  });

  $('#assistant-button').addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  $('#assistant-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.classList.contains('hidden')) setOpen(false);
  });

  return { open: () => setOpen(true), close: () => setOpen(false) };
}
