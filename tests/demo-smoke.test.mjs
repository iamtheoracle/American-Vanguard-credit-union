import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, js, css, netlify] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8'),
]);

test('initial member overview renders balances and demo disclaimer in HTML before JavaScript runs', () => {
  assert.match(html, /id="total-balance"[^>]*>\$12,480\.65/);
  assert.match(html, /Share Draft[\s\S]*?\$3,240\.65/);
  assert.match(html, /Primary Share[\s\S]*?\$6,840\.00/);
  assert.match(html, /Money Market[\s\S]*?\$1,900\.00/);
  assert.match(html, /Holiday Club[\s\S]*?\$500\.00/);
  assert.match(html, /DEMONSTRATION ONLY/);
  assert.match(html, /not a real credit union account/i);
});

test('all promised demo journeys have their controls and handlers', () => {
  for (const id of [
    'transfer-form', 'transfer-kind', 'transfer-from', 'transfer-to', 'bill-payee',
    'deposit-form', 'deposit-amount', 'freeze-toggle', 'simulate-purchase',
    'purchase-result', 'reset-demo', 'confirm-dialog', 'all-transactions'
  ]) assert.ok(html.includes(`id="${id}"`), `expected UI control #${id}`);
  for (const feature of [
    'submitTransfer', 'submitDeposit', 'toggleFreeze', 'simulatePurchase',
    'resetDemo', 'renderAll', 'renderAllTransactions'
  ]) assert.ok(js.includes(feature), `expected handler ${feature}`);
  assert.match(js, /state\.balances\[from\] < amountCents/);
  assert.match(js, /if \(state\.frozen\)/);
  assert.match(js, /state\.frozen = next/);
  assert.match(js, /localStorage\.setItem\(STORAGE_KEY/);
  assert.ok(js.includes('Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7'));
  assert.ok(js.includes('amount > 10000'));
});

test('member-facing navigation supports desktop and mobile layouts', () => {
  for (const view of ['home', 'move', 'deposit', 'card', 'more']) {
    assert.match(html, new RegExp(`data-nav="${view}"`));
    assert.match(html, new RegExp(`id="view-${view}"`));
  }
  assert.match(css, /@media\(max-width:620px\)/);
  assert.match(css, /\.mobile-nav\{[^}]*display:grid/s);
  assert.match(css, /prefers-reduced-motion/);
});

test('the demo does not connect to external services or use remote fonts', () => {
  assert.match(js, /fetch\(\`\$\{endpoint\}\?q=/);
  assert.match(js, /credentials: 'same-origin'/);
  assert.doesNotMatch(js, /https?:\\/\\//);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(css, /@import\s+url\s*\(/i);
  assert.match(netlify, /connect-src 'self'/);
  assert.match(netlify, /publish = "\."/);
});

test('user-entered strings are escaped before HTML rendering', () => {
  assert.match(js, /function escapeHtml\(value\)/);
  assert.match(js, /escapeHtml\(transaction\.title\)/);
  assert.match(js, /escapeHtml\(merchant\)/);
  assert.match(js, /escapeHtml\(payee\)/);
});
  assert.ok(js.includes('encodeURIComponent(query)'));
  assert.ok(js.includes("credentials: 'same-origin'"));
  assert.ok(!js.includes('https://') && !js.includes('http://'));