import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [index, ops, css, app, apiJs, chat, opsJs, pkgRaw] = await Promise.all([
  read('index.html'), read('ops.html'), read('styles.css'),
  read('js/app.js'), read('js/api.js'), read('js/chat.js'), read('js/ops.js'), read('package.json')
]);
const pkg = JSON.parse(pkgRaw);

test('member and staff applications are separate and declare a mobile viewport', () => {
  assert.match(index, /<meta name="viewport" content="width=device-width/);
  assert.match(ops, /<meta name="viewport" content="width=device-width/);
  assert.match(index, /id="auth-screen"/);
  assert.match(index, /id="member-app"/);
  assert.match(ops, /id="ops-auth"/);
  assert.match(ops, /id="ops-app"/);
  assert.match(index, /href="\.\/ops\.html"/);
  assert.match(ops, /href="\.\/index\.html"/);
  assert.doesNotMatch(index, /server\/index\.js|package\.json/);
});

test('every member journey has a view and a navigation entry', () => {
  const views = ['overview', 'accounts', 'move', 'deposit', 'requests', 'activity',
    'card', 'rewards', 'invest', 'loans', 'support', 'security'];
  for (const view of views) {
    assert.ok(index.includes(`id="view-${view}"`), `missing view ${view}`);
    assert.ok(app.includes(`data-view-link="${view}"`) || index.includes(`data-view-link="${view}"`),
      `missing navigation for ${view}`);
  }
  assert.match(index, /id="mobile-nav"/);
  assert.match(index, /id="transfer-form"/);
  assert.match(index, /id="deposit-form"/);
  assert.match(index, /id="request-form"/);
  assert.match(index, /id="invest-form"/);
  assert.match(index, /id="loan-form"/);
  assert.match(app, /api\('\/requests'\)/);
  assert.match(app, /api\('\/loans'\)/);
  assert.match(app, /api\('\/investments'\)/);
});

test('the assistant send control submits the form directly', () => {
  assert.match(index, /<form class="assistant-input" id="assistant-form">/);
  assert.match(index, /id="assistant-message"/);
  assert.match(index, /class="assistant-send" type="submit"/);
  assert.match(index, /aria-label="Send message"/);
  assert.match(chat, /form\.addEventListener\('submit'/);
  assert.match(chat, /\/ai\/chat/);
  assert.match(chat, /\/ai\/retry/);
  assert.match(chat, /data-human-support/);
});

test('operator console exposes the complete control surface', () => {
  for (const view of ['queue', 'approvals', 'members', 'cases', 'transactions',
    'imports', 'lending', 'ai', 'audit', 'team', 'integrations']) {
    assert.ok(ops.includes(`data-ops-view="${view}"`), `missing ops view ${view}`);
    assert.ok(ops.includes(`data-ops-section="${view}"`), `missing ops section ${view}`);
  }
  assert.match(ops, /id="historical-form"/);
  assert.match(ops, /id="import-form"/);
  assert.match(ops, /id="decision-dialog"/);
  assert.match(opsJs, /\/operator\/approvals\//);
  assert.match(opsJs, /\/operator\/transactions/);
  assert.match(opsJs, /\/operator\/imports/);
});

test('responsive layouts cover desktop, tablet, and mobile breakpoints', () => {
  assert.match(css, /@media\(max-width:1190px\)/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /@media\(max-width:620px\)/);
  assert.match(css, /\.mobile-nav\{[^}]*display:grid/s);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /min-width:320px/);
  assert.match(css, /\.assistant-panel\{[^}]*width:min\(390px/s);
  assert.match(css, /\.security-grid\{[^}]*grid-template-columns:repeat\(auto-fit/s);
});

test('browser code uses same-origin APIs, HttpOnly sessions, and escapes rendered data', () => {
  assert.match(app, /from '\.\/api\.js'/);
  assert.match(app, /escapeHtml\(/);
  assert.match(apiJs, /credentials: 'same-origin'/);
  assert.match(apiJs, /fetch\(`\/api\$\{path\}`/);
  assert.doesNotMatch(app, /localStorage|sessionStorage/);
  assert.doesNotMatch(chat, /localStorage|sessionStorage/);
  assert.doesNotMatch(index, /<script>[\s\S]*?<\/script>/);
  assert.match(index, /<script type="module" src="\.\/js\/app\.js">/);
  assert.match(ops, /<script type="module" src="\.\/js\/ops\.js">/);
  assert.doesNotMatch(index, /https?:\/\//);
  assert.doesNotMatch(ops, /https?:\/\//);
});

test('quality scripts check every browser and server module', () => {
  assert.match(pkg.scripts.check, /node --check js\/app\.js/);
  assert.match(pkg.scripts.check, /node --check js\/ops\.js/);
  assert.match(pkg.scripts.check, /node --check js\/chat\.js/);
  assert.match(pkg.scripts.check, /node --check server\/routes-member\.js/);
  assert.match(pkg.scripts.check, /node --check server\/services-finance\.js/);
  assert.match(pkg.scripts.test, /node --test/);
  assert.equal(pkg.dependencies.express !== undefined, true);
  assert.equal(pkg.dependencies.pg !== undefined, true);
});
