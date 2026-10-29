import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, workflow, css, readme, pkg, netlify] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../workflow.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8')
]);

test('AVCU workspace provides eight account categories and no fabricated opening balances', () => {
  assert.match(html, /Atchison Village Credit Union/);
  for (const account of ['Share Draft', 'Primary Share', 'Money Market', 'Holiday Club', 'Business Operating Account', 'Traditional IRA', 'Share Certificate', '401\\(k\\) Retirement']) {
    assert.ok(html.includes(account), 'missing account label: ' + account);
  }
  assert.match(app, /balances: \\{ draft: 0, primary: 0, market: 0, holiday: 0, business: 0, ira: 0, certificate: 0, retirement401k: 0 \\}/);
  assert.doesNotMatch(html, /\\$3,240\\.65|\\$6,840\\.00|\\$24,230\\.65|4826|JORDAN HALE/);
  assert.match(html, /STANDALONE OPERATIONS/);
  assert.match(html, /External financial services require authorized connections/);
});

test('payment workspace supports request initiation and local operator review', () => {
  for (const id of ['view-operations','workflow-form','workflow-type','workflow-from','workflow-to','workflow-recipient','workflow-destination','workflow-currency','workflow-member-queue','workflow-operator-queue','workflow-pending-count']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing workflow control ' + id);
  }
  for (const type of ['internal-transfer','bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','check-deposit']) {
    assert.ok(workflow.includes("'" + type + "'") || workflow.includes(type), 'missing workflow type ' + type);
  }
  assert.match(workflow, /pending-approval/);
  assert.match(workflow, /approved-awaiting-provider/);
  assert.match(workflow, /needs-information/);
  assert.match(workflow, /Request information/);
  assert.match(workflow, /decisionBy/);
  assert.match(workflow, /audit\\.push/);
});

test('legacy transfer and deposit forms cannot post unapproved transactions', () => {
  assert.match(app, /Payment workflow is unavailable\\. No transaction was posted/);
  assert.match(app, /No account was credited/);
  assert.match(workflow, /addEventListener\\('submit',submit,true\\)/);
  assert.match(workflow, /stopImmediatePropagation/);
  assert.match(workflow, /Submit for approval/);
});

test('internal transfer posts only after approval and checks source funds', () => {
  assert.match(workflow, /s\\.balances\\[r\\.from\\]<r\\.amountCents/);
  assert.match(workflow, /s\\.balances\\[r\\.from\\]-=r\\.amountCents/);
  assert.match(workflow, /s\\.balances\\[r\\.to\\]\\+=r\\.amountCents/);
  assert.match(workflow, /Approved internal transfer/);
  assert.match(workflow, /if\\(b\\.dataset\\.review==='approve'&&r\\.type==='internal-transfer'\\)/);
});

test('external approvals never claim provider settlement', () => {
  assert.match(workflow, /providerState:'not-connected'/);
  assert.match(workflow, /approved-awaiting-provider/);
  assert.match(workflow, /no external funds have been sent or settled/);
  assert.match(workflow, /unavailable-without-provider/);
  assert.match(html, /Live payment rails are not configured/);
});

test('check deposits request front and back images with camera capture and preview', () => {
  for (const id of ['check-front','check-back','legacy-check-front','legacy-check-back','check-front-preview','check-back-preview']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /capture="environment"/);
  assert.match(workflow, /Capture or select both the front and back/);
  assert.match(workflow, /Review check images/);
  assert.match(workflow, /Images are not retained after refresh/);
});

test('card authorization requests are routed through review, not direct debits', () => {
  assert.match(workflow, /card-authorization/);
  assert.match(workflow, /closest\\('#simulate-purchase'\\)/);
  assert.match(app, /No merchant authorization or account debit occurred/);
  assert.doesNotMatch(app, /state\\.balances\\.draft -= amountCents/);
});

test('responsive and accessibility basics remain present', () => {
  assert.match(css, /@media\\(max-width:620px\\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(css, /workflow-request/);
});

test('README and scripts document real standalone boundaries', () => {
  assert.match(readme, /Pending Approval/);
  assert.match(readme, /Approved · Awaiting Provider/);
  assert.match(readme, /not protected by real staff authentication/);
  assert.match(readme, /provider-confirmed outcomes may be marked settled/);
  assert.doesNotMatch(readme, /sample balances|demo ledger/);
  assert.match(pkg, /node --check workflow\\.js/);
  assert.match(netlify, /connect-src 'none'/);
});
