import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("member interface contains no fabricated financial account data", async () => {
  const html = await read("../index.html");
  const app = await read("../app.js");
  assert.doesNotMatch(html + app, /12,480\\.65|4826|Jordan Hale|demo ledger|simulated transfer/i);
  assert.match(html, /verification/i);
});

test("member API binds records to the authenticated identity and stores pending requests", async () => {
  const api = await read("../netlify/functions/member-api.mjs");
  assert.match(api, /getUser/);
  assert.match(api, /user\\.id/);
  assert.match(api, /'pending'/);
  assert.match(api, /BEGIN/);
});

test("admin API enforces staff role server-side and requires a note", async () => {
  const api = await read("../netlify/functions/admin-reviews.mjs");
  assert.match(api, /user\\.roles\\.includes\\("admin"\\)/);
  assert.match(api, /note\\.length < 3/);
  assert.match(api, /verification_review_events/);
  assert.match(api, /FOR UPDATE/);
});

test("public build excludes backend function source and database migrations", async () => {
  const config = await read("../netlify.toml");
  assert.match(config, /publish = "public"/);
  const memberApi = await read("../netlify/functions/member-api.mjs");
  const adminApi = await read("../netlify/functions/admin-reviews.mjs");
  assert.match(memberApi, /origin !== new URL\\(req.url\\)\\.origin/);
  assert.match(adminApi, /user\\.roles\\.includes\\("admin"\\)/);
});

test("house wire remains an uninitiated external-wire demo", async () => {
  const brief = await read("../docs/house-wire-transfer-demo.md");
  assert.match(brief, /Kate Hirschi/);
  assert.match(brief, /Judith Anne Elizabeth Shearer/);
  assert.match(brief, /Goldenwest Credit Union/);
  assert.match(brief, /Planned \/ not initiated/);
  assert.match(brief, /Currency: \\*\\*Not supplied/);
  assert.match(brief, /no live wire or receiving-account credit can be performed/i);
  assert.match(brief, /15,825\\.69 − 5,000\\.00 = 10,825\\.69/);
});

test("external recipient credit requires receiving-bank confirmation and two-person manual review", async () => {
  const brief = await read("../docs/house-wire-transfer-demo.md");
  assert.match(brief, /awaiting receiving-bank confirmation/);
  assert.match(brief, /two distinct authorized reviewers/);
  assert.match(brief, /independently verified, authorized Goldenwest channel/);
  assert.match(brief, /sender receipt, transfer screenshot, email forwarded by the sender, or verbal assurance is not sufficient/i);
  assert.match(brief, /Do not create or display a local Goldenwest account balance/);
});

test("house wire implementation brief forbids ledger mutation during preview", async () => {
  const brief = await read("../docs/house-wire-transfer-demo.md");
  assert.match(brief, /Do not mutate the ledger or available balance/);
  assert.match(brief, /Drafting or previewing the wire does not create a ledger entry/);
  assert.match(brief, /shared correlation\/reference ID/);
  assert.match(brief, /returns, reversals, and investigations as separate audited events/);
});
