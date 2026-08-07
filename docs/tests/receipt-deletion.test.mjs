import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("receipt deletion is audited, reversible, and payer-or-owner-gated", async () => {
  const [app, migration] = await Promise.all([
    read("docs/app.js"),
    read("supabase/migrations/20260809000000_receipt_soft_delete_audit.sql")
  ]);

  assert.match(app, /async function deleteReceipt/);
  assert.match(app, /delete_purchase_receipt/);
  assert.match(app, /restore_purchase_receipt/);
  assert.match(app, /The audit record is retained in Household settings/);
  assert.match(migration, /receipt_deleted/);
  assert.match(migration, /receipt_restored/);
  assert.match(migration, /Only the payer or household owner can delete this receipt/);
  assert.match(migration, /guard_purchase_receipt_lifecycle/);
  assert.match(migration, /revoke delete on public\.purchases from anon, authenticated/);
});
