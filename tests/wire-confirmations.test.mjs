import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("wire confirmation schema is separate from member and financial ledgers", async () => {
  const sql = await read("../netlify/database/migrations/20261030010000_create_external_wire_confirmation_queue.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS external_wire_cases/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS external_wire_evidence/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS external_wire_review_events/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(sql, /CREATE TABLE.*ledger|UPDATE .*balance|INSERT INTO .*ledger/i);
});

test("wire API uses dedicated roles and rejects submitter self-approval", async () => {
  const api = await read("../netlify/functions/wire-confirmations.mjs");
  assert.match(api, /wire_operations_admin/);
  assert.match(api, /wire_evidence_submitter/);
  assert.match(api, /wire_confirmation_approver/);
  assert.match(api, /evidence\.rows\[0\]\.submitted_by===String\(actor\.id\)/);
  assert.match(api, /origin !== new URL\(req.url\)\.origin/);
  assert.match(api, /FOR UPDATE/);
});

test("wire confirmation API accepts only private evidence vault references", async () => {
  const api = await read("../netlify/functions/wire-confirmations.mjs");
  assert.match(api, /vault:\[A-Za-z0-9\/_-\]/);
  assert.match(api, /Public URLs are not accepted/);
  assert.match(api, /financialEffect:"none"/);
  assert.doesNotMatch(api, /fetch\(.*goldenwest|provider\.transfer|debit_account|credit_account/i);
});
