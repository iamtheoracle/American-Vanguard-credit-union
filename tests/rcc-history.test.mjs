import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, script, styles] = await Promise.all([
  readFile(new URL('../rcc-history.html', import.meta.url), 'utf8'),
  readFile(new URL('../rcc-history.js', import.meta.url), 'utf8'),
  readFile(new URL('../rcc-history.css', import.meta.url), 'utf8')
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
