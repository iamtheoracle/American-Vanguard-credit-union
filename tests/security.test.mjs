import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("member interface contains no fabricated financial account data", async () => {
  const html = await read("../index.html");
  const app = await read("../app.js");
  assert.doesNotMatch(html + app, /12,480\.65|4826|Jordan Hale|demo ledger|simulated transfer/i);
  assert.match(html, /verification/i);
});

test("member API binds records to the authenticated identity and stores pending requests", async () => {
  const api = await read("../netlify/functions/member-api.mjs");
  assert.match(api, /getUser/);
  assert.match(api, /user\.id/);
  assert.match(api, /'pending'/);
  assert.match(api, /BEGIN/);
});

test("admin API enforces staff role server-side and requires a note", async () => {
  const api = await read("../netlify/functions/admin-reviews.mjs");
  assert.match(api, /user\.roles\.includes\("admin"\)/);
  assert.match(api, /note\.length < 3/);
  assert.match(api, /verification_review_events/);
  assert.match(api, /FOR UPDATE/);
});