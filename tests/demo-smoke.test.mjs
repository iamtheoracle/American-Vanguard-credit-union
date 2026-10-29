import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, js, css, netlify, readme] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
]);

test('AVCU identity, seven demo accounts, and disclaimers are consistent', () => {
  assert.match(html, /Atchison Village Credit Union/);
  assert.match(html, /id="total-balance"[^>]*>\$24,230\.65/);
  for (const account of ['Share Draft', 'Primary Share', 'Money Market', 'Holiday Club', 'Business Operating Account', 'Traditional IRA', 'Share Certificate']) {
    assert.ok(html.includes(account), 'expected account ' + account);
    assert.ok(js.includes(account), 'expected account model ' + account);
  }
  assert.match(html, /LOCAL DEMONSTRATION ONLY/);
  assert.match(html, /not a real credit union account/i);
  assert.match(html, /NCUA insurance/i);
  assert.match(html, /Richmond &amp; San Pablo/i);
  assert.match(readme, /Atchison Village Credit Union \(AVCU\)/);
  assert.match(readme, /seven sample accounts/i);
  assert.doesNotMatch(readme, /American Vanguard Credit Union/);
});

test('all member journeys expose controls and handlers', () => {
  for (const id of [
    'transfer-form', 'transfer-kind', 'transfer-from', 'transfer-to', 'bill-payee',
    'deposit-form', 'deposit-amount', 'deposit-account-guidance', 'account-guidance',
    'freeze-toggle', 'simulate-purchase', 'purchase-result', 'reset-demo', 'confirm-dialog', 'all-transactions'
  ]) assert.ok(html.includes('id="' + id + '"'), 'expected UI control #' + id);
  for (const feature of [
    'submitTransfer', 'submitDeposit', 'toggleFreeze', 'simulatePurchase',
    'resetDemo', 'renderAll', 'renderAllTransactions', 'renderAccountGuidance'
  ]) assert.ok(js.includes(feature), 'expected handler ' + feature);
  assert.match(js, /state\.balances\[from\] < amountCents/);
  assert.match(js, /state\.frozen = next/);
  assert.match(js, /localStorage\.setItem\(STORAGE_KEY/);
  assert.match(js, /Migrate older local demo saves/);
});

test('transfer and bill payment validation guard against invalid targets, amounts, and overdrafts', () => {
  assert.match(js, /!\['share', 'bill'\]\.includes\(kind\)/);
  assert.match(js, /to === from/);
  assert.match(js, /safeMoneyInput\(amount\)/);
  assert.match(js, /state\.balances\[from\] < amountCents/);
  assert.match(js, /kind === 'bill' && \(!payee \|\| payee\.length > 80\)/);
  assert.match(js, /state\.balances\[from\] -= amountCents/);
  assert.match(js, /state\.balances\[to\] \+= amountCents/);
  assert.match(js, /addTransaction\(to, 'Transfer received', amountCents/);
});

test('deposits are bounded and recorded, including account-specific demo guidance', () => {
  assert.match(js, /amount > 100000/);
  assert.match(js, /!description \|\| description\.length > 80/);
  assert.match(js, /state\.balances\[account\] \+= amountCents/);
  assert.match(js, /addTransaction\(account, description, amountCents/);
  assert.match(js, /Traditional IRA is illustrative only/);
  assert.match(js, /Share Certificate is illustrative only/);
});

test('debit card simulator enforces freeze and funds, then updates balance and ledger', () => {
  assert.match(js, /if \(state\.frozen\)/);
  assert.match(js, /state\.balances\.draft < amountCents/);
  assert.match(js, /state\.balances\.draft -= amountCents/);
  assert.match(js, /addTransaction\('draft', merchant, -amountCents, 'Card purchase'\)/);
  assert.match(js, /renderAll\(\)/);
  assert.match(html, /An approved test purchase reduces the Share Draft demo balance/);
});

test('navigation, responsive styling, reduced motion, and keyboard focus are present', () => {
  for (const view of ['home', 'move', 'deposit', 'card', 'more']) {
    assert.match(html, new RegExp('data-nav="' + view + '"'));
    assert.match(html, new RegExp('id="view-' + view + '"'));
  }
  assert.match(css, /@media\(max-width:620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
});

test('the demo does not connect to external services or load remote fonts', () => {
  assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(css, /@import\s+url\s*\(/i);
  assert.match(netlify, /connect-src 'none'/);
  assert.match(netlify, /publish = "\."/);
});

test('user-entered text is escaped before dynamic HTML rendering', () => {
  assert.match(js, /function escapeHtml\(value\)/);
  assert.match(js, /escapeHtml\(transaction\.title\)/);
  assert.match(js, /escapeHtml\(merchant\)/);
  assert.match(js, /escapeHtml\(payee\)/);
});
