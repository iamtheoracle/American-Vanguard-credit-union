import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, workflow, providers, css, readme, pkg, netlify] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../workflow.js', import.meta.url), 'utf8'),
  readFile(new URL('../providers.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8')
]);

test('AVCU workspace has eight account categories and no fabricated opening balances', () => {
  assert.ok(html.includes('Atchison Village Credit Union'));
  for (const account of ['Share Draft', 'Primary Share', 'Money Market', 'Holiday Club', 'Business Operating Account', 'Traditional IRA', 'Share Certificate', '401(k) Retirement']) {
    assert.ok(html.includes(account), 'missing account label: ' + account);
  }
  assert.ok(app.includes('balances: { draft: 0, primary: 0, market: 0, holiday: 0, business: 0, ira: 0, certificate: 0, retirement401k: 0 }'));
  for (const fake of ['$3,240.65', '$6,840.00', '$24,230.65', '4826', 'JORDAN HALE']) assert.ok(!html.includes(fake), 'unexpected fabricated detail: ' + fake);
  assert.ok(html.includes('STANDALONE OPERATIONS'));
  assert.ok(html.includes('External financial services require authorized connections'));
});

test('payment workspace supports request initiation and operator review', () => {
  for (const id of ['view-operations','workflow-form','workflow-type','workflow-from','workflow-to','workflow-recipient','workflow-destination','workflow-currency','workflow-member-queue','workflow-operator-queue','workflow-pending-count']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing workflow control ' + id);
  }
  for (const type of ['internal-transfer','bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','check-deposit','card-authorization']) assert.ok(workflow.includes(type), 'missing workflow type ' + type);
  for (const value of ['pending-approval','approved-awaiting-provider','needs-information','Request information','decisionBy','audit.push']) assert.ok(workflow.includes(value), 'missing approval behavior ' + value);
});

test('legacy forms cannot post unapproved transfers or deposits', () => {
  assert.ok(app.includes('Payment workflow is unavailable. No transaction was posted.'));
  assert.ok(app.includes('No account was credited.'));
  assert.ok(workflow.includes("addEventListener('submit',submit,true)"));
  assert.ok(workflow.includes('stopImmediatePropagation'));
  assert.ok(workflow.includes('Submit for approval'));
});

test('internal transfers check available funds and post only after operator approval', () => {
  for (const value of ['s.balances[r.from]<r.amountCents','s.balances[r.from]-=r.amountCents','s.balances[r.to]+=r.amountCents','Approved internal transfer',"b.dataset.review==='approve'&&r.type==='internal-transfer'"]) {
    assert.ok(workflow.includes(value), 'missing internal-transfer control ' + value);
  }
  assert.ok(app.includes("window.addEventListener('avcu:member-state-updated'"));
});

test('external approvals remain un-settled until provider confirmation', () => {
  for (const value of ["providerState:'not-connected'",'approved-awaiting-provider','no external funds have been sent or settled','unavailable-without-provider']) assert.ok(workflow.includes(value));
  assert.ok(providers.includes('PROVIDER_NOT_CONFIGURED'));
  assert.ok(providers.includes('register'));
  assert.ok(html.includes('External financial services require authorized connections'));
});

test('check deposits capture both sides and provide previews', () => {
  for (const id of ['check-front','check-back','legacy-check-front','legacy-check-back','check-front-preview','check-back-preview']) assert.ok(html.includes('id="' + id + '"'));
  assert.ok(html.includes('capture="environment"'));
  assert.ok(workflow.includes('Capture or select both the front and back'));
  assert.ok(workflow.includes('Review check images'));
  assert.ok(workflow.includes('Images are not retained after refresh'));
});

test('card authorization requests route to review and do not debit the account directly', () => {
  assert.ok(workflow.includes('card-authorization'));
  assert.ok(workflow.includes("closest('#simulate-purchase')"));
  assert.ok(app.includes('No merchant authorization or account debit occurred'));
  assert.ok(!app.includes('state.balances.draft -= amountCents'));
});

test('responsive layout and accessibility basics remain', () => {
  assert.ok(css.includes('@media(max-width:620px)'));
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes('focus-visible'));
  assert.ok(html.includes('class="skip-link"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(css.includes('workflow-request'));
});

test('documentation and scripts describe standalone and provider boundaries', () => {
  for (const value of ['Pending Approval','Approved · Awaiting Provider','not protected by real staff authentication','provider-confirmed outcomes may be marked settled']) assert.ok(readme.includes(value));
  assert.ok(!readme.includes('sample balances'));
  assert.ok(pkg.includes('node --check workflow.js'));
  assert.ok(netlify.includes("connect-src 'none'"));
});
