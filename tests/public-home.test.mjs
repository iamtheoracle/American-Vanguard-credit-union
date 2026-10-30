import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('public homepage contains no fabricated banking records or claims', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const forbidden of [
    'American Vantoris', 'Jordan Hale', '12,480.65', '4826',
    'Demo payroll', 'SAMPLE LEDGER', 'Since 1959', 'Richmond & San Pablo',
    'member-owned', 'sample rate', 'demo-ribbon', 'localStorage'
  ]) assert.equal(html.toLowerCase().includes(forbidden.toLowerCase()), false, `unexpected public placeholder: ${forbidden}`);
  assert.match(html, /America Vanguard CREDIT UNION/i);
  assert.match(html, /not currently accepting deposits/i);
  assert.match(html, /Secure member portal/);
});

test('public homepage does not load a local browser banking simulator', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+app\.js/i);
  assert.doesNotMatch(html, /styles\.css/);
});
