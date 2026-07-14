import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("shared web flow is staged rather than showing a ledger behind sign-in", async () => {
  const [page, app] = await Promise.all([read("docs/index.html"), read("docs/app.js")]);
  assert.match(page, /id="screen"/);
  assert.doesNotMatch(page, /id="sync-panel"/);
  assert.match(app, /function renderSignedOut/);
  assert.match(app, /function renderHouseholdPicker/);
  assert.match(app, /function renderDashboard/);
  assert.match(app, /Names do not need to be unique/);
});

test("lifecycle migration enforces the approved role and recovery rules", async () => {
  const sql = await read("supabase/multi-household-lifecycle.sql");
  assert.match(sql, /role in \('owner', 'admin', 'member'\)/);
  assert.match(sql, /interval '30 days'/);
  assert.match(sql, /Transfer ownership before removing the owner/);
  assert.match(sql, /Settle every member’s balance before archiving this household/);
  assert.match(sql, /purge_after <= now\(\)/);
  assert.match(sql, /request_admin_access/);
  assert.match(sql, /managers or authors update purchases/);
  assert.match(sql, /create_household_invite/);
  assert.match(sql, /Invalid or inactive household invite code/);
});

test("local PDF privacy and duplicate safeguards remain present", async () => {
  const [app, sql] = await Promise.all([read("docs/app.js"), read("supabase/add-local-pdf-imports.sql")]);
  assert.match(app, /Reading this PDF locally/);
  assert.match(app, /exactHash/);
  assert.match(app, /contentHash/);
  assert.match(sql, /unique \(household_id, exact_pdf_hash\)/);
  assert.match(sql, /unique \(household_id, content_hash\)/);
});
