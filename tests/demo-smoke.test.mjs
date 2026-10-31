import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, portal, portalJs, netlify, homeCss, cardArt] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../member-portal.html', import.meta.url), 'utf8'),
  readFile(new URL('../member-portal.js', import.meta.url), 'utf8'),
  readFile(new URL('../netlify.toml', import.meta.url), 'utf8'),
  readFile(new URL('../home.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/avcu-card-collection.svg', import.meta.url), 'utf8'),
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
  assert.match(html, /assets\/avcu-card-collection\.svg/);
  assert.match(cardArt, /<svg[\s\S]*?role="img"/);
  assert.match(homeCss, /@media\(max-width:620px\)/);
  assert.match(homeCss, /prefers-reduced-motion/);
  assert.match(html, /Skip to content/);
  assert.doesNotMatch(html + homeCss, /https?:\/\//);
  assert.doesNotMatch(homeCss, /fonts\.googleapis|fonts\.gstatic/i);
  assert.match(netlify, /connect-src 'self'/);
  assert.match(netlify, /publish = "\."/);
});

test('member portal does not offer unsupported deposits or simulated card controls', () => {
  assert.doesNotMatch(portal, /id="deposit-form"|id="purchase-form"|id="freeze-button"|Test authorization|Submit deposit/i);
  assert.match(portal, /Deposits unavailable/);
  assert.match(portal, /No live card issuer or processor is connected/);
  assert.match(portal, /Internal share transfer/);
  assert.doesNotMatch(portalJs, /api\('\/deposits'|post\('\/card\/freeze'|post\('\/card\/test-purchase'/);
});

test('development seed refuses to create sample accounts in production', async () => {
  const seed = await readFile(new URL('../server/seed.js', import.meta.url), 'utf8');
  assert.match(seed, /NODE_ENV === 'production'/);
  assert.match(seed, /Development seed is disabled in production/);
});
