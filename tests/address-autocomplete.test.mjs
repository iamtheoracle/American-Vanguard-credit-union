import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const netlify = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const docs = await readFile(new URL('../docs/address-autocomplete.md', import.meta.url), 'utf8');

test('address suggestions are opt-in and disabled until explicitly enabled', () => {
  assert.match(html, /id="address-suggestions-enabled" type="checkbox"/);
  assert.match(html, /id="address-search"[^>]*disabled/);
});

test('address completion has structured fields and manual fallback', () => {
  for (const id of ['address-city','address-region','address-postal','address-country']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(js, /You can enter the address manually/);
  assert.match(js, /selectAddressSuggestion/);
});

test('autocomplete is same-origin, debounced, bounded and cancellable', () => {
  assert.match(js, /startsWith\('\/'\)/);
  assert.match(js, /setTimeout\(\(\) => requestAddressSuggestions\(query\), 300\)/);
  assert.match(js, /new AbortController\(\)/);
  assert.match(js, /slice\(0, 6\)/);
  assert.match(netlify, /connect-src 'self'/);
  assert.doesNotMatch(netlify, /connect-src[^;]*https?:/);
});

test('suggestion content is inserted as text, not provider HTML', () => {
  assert.match(js, /title\.textContent = item\.label/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*item\./);
});

test('documentation prohibits direct third-party browser lookup and address verification claims', () => {
  assert.match(docs, /Do not call a third-party geocoding API directly from the browser/);
  assert.match(docs, /not proof of residence, identity, or eligibility/);
});
