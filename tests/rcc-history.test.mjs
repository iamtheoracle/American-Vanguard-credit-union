import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, script, styles, operatorRoutes, operatorScript, operatorHtml] = await Promise.all([
  readFile(new URL('../rcc-history.html', import.meta.url), 'utf8'),
  readFile(new URL('../rcc-history.js', import.meta.url), 'utf8'),
  readFile(new URL('../rcc-history.css', import.meta.url), 'utf8'),
  readFile(new URL('../server/routes-operator.js', import.meta.url), 'utf8'),
  readFile(new URL('../operator-portal.js', import.meta.url), 'utf8'),
  readFile(new URL('../operator-portal.html', import.meta.url), 'utf8')
]);

test('RCC reporting identity and period are present', () => {
  assert.match(html, /RCC — Road Construction Company/);
  assert.match(html, /Kessler Lazaroski/);
  assert.match(html, /Mar 25, 2018 — Oct 31, 2026/);
});

test('all supplied annual closing snapshots are preserved in cents', () => {
  for (const [year, cents] of [
    [2018,2627567500],[2019,2904502500],[2020,3131387500],[2021,3383975500],
    [2022,3042698500],[2023,3157198500],[2024,3374848500],[2025,3696873500]
  ]) assert.match(script, new RegExp('year:' + year + ',close:' + cents));
});

test('reconciliation exception is explicit and not auto-balanced', () => {
  assert.match(html, /\$5,291,565\.00/);
  assert.match(html, /No balancing transaction has been created/);
  assert.match(html, /No source transactions imported/);
});

test('scenario assumptions are separated from verified history', () => {
  assert.match(html, /Not actual account performance/);
  assert.match(html, /Illustrative assumptions/);
  assert.match(script, /October 1–28, 2026/);
});

test('exports are templates and do not fabricate ledger rows', () => {
  assert.match(script, /RCC-ledger-import-template\.csv/);
  assert.match(script, /RCC-fee-import-template\.csv/);
  assert.match(html, /No unsupported transactions, fees, or opening balances have been added/);
});

test('workspace has responsive and print styling', () => {
  assert.match(styles, /@media\(max-width:560px\)/);
  assert.match(styles, /@media print/);
});

test('operator history defaults to the requested complete reporting period', () => {
  assert.match(operatorRoutes, /req\.query\.from \|\| '2018-03-25'/);
  assert.match(operatorRoutes, /req\.query\.to \|\| '2026-10-31'/);
  assert.match(operatorHtml, /value="2018-03-25"/);
  assert.match(operatorHtml, /value="2026-10-31"/);
});

test('monthly aggregation uses account membership EXISTS and avoids join multiplication', () => {
  const monthlyStart = operatorRoutes.indexOf("date_trunc('month'");
  const monthlyEnd = operatorRoutes.indexOf('lastRecordedActivity', monthlyStart);
  const monthly = operatorRoutes.slice(monthlyStart, monthlyEnd);
  assert.match(monthly, /WHERE EXISTS/);
  assert.doesNotMatch(monthly, /JOIN accounts a ON a\.id = t\.from_account_id OR a\.id = t\.to_account_id/);
});

test('history API and operator UI preserve exact cent values', () => {
  assert.match(operatorRoutes, /const exactMoney = rows/);
  assert.doesNotMatch(operatorRoutes, /Number\(value\).*Cents/);
  assert.match(operatorScript, /BigInt\(digits\)/);
  assert.match(operatorScript, /toLocaleString\('en-US'\)/);
});

test('operator statement labels distinguish initiation from posting', () => {
  assert.match(operatorScript, /Initiation time is not proof of settlement or posting/);
  assert.match(operatorScript, /Weekly Account Summary/);
  assert.match(operatorScript, /Monthly Account Statement Summary/);
});
