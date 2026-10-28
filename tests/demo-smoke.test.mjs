import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, netlify] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8'),
]);

test('public entry page routes members and authorized staff to their separate sign-in spaces', () => {
  assert.match(html, /href="\/member-portal\.html"/);
  assert.match(html, /href="\/operator-portal\.html"/);
  assert.match(html, /Member sign in/);
  assert.match(html, /Staff and operations/);
  assert.match(html, /Secure access/);
});

test('public entry page does not present invented account balances or seeded member data', () => {
  assert.doesNotMatch(html, /\$12,480\.65|Jordan Hale|Demo member|DEMONSTRATION ONLY|Local demo|Member Banking Demo/i);
  assert.doesNotMatch(html, /id="total-balance"/);
  assert.match(html, /does not represent account balances/i);
});

test('landing page uses self-hosted vector branding and responsive, accessible styling', () => {
  assert.match(html, /<svg[\s\S]*?aria-hidden="true"/);
  assert.match(html, /@media\(max-width:850px\)/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /Skip to content/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/i);
  assert.match(netlify, /connect-src 'self'/);
  assert.match(netlify, /publish = "\."/);
});
