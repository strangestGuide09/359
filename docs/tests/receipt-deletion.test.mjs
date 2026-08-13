import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("receipt deletion is audited, reversible, and payer-or-owner-gated", async () => {
  const [app, page, style, migration] = await Promise.all([
    read("docs/app.js"),
    read("docs/index.html"),
    read("docs/style.css"),
    read("supabase/migrations/20260809000000_receipt_soft_delete_audit.sql")
  ]);

  assert.match(app, /function deleteReceipt/);
  assert.match(app, /delete_purchase_receipt/);
  assert.match(app, /restore_purchase_receipt/);
  assert.match(app, /It no longer affects balances or Possible Buys and remains restorable/);
  assert.match(app, /class="receipt-action-buttons" data-label="Actions" role="group" aria-label="Receipt actions for \$\{heading\}"/);
  assert.match(app, /type="button" class="receipt-edit" data-edit-receipt=/);
  assert.match(app, /aria-label="Edit receipt for \$\{heading\}"/);
  assert.match(app, /type="button" class="receipt-delete" data-delete-receipt=/);
  assert.match(app, /aria-label="Remove \$\{heading\} from the ledger"/);
  assert.match(app, /<svg aria-hidden="true"[^>]*focusable="false"/);
  assert.match(app, /<span>Remove<\/span>/);
  assert.match(app, /<span>Amount<\/span><span>Actions<\/span>/);
  assert.match(style, /\.ledger-columns,\.purchase-row \{ display:grid; grid-template-columns:[^;}]*minmax\(222px,1fr\); gap:12px;/);
  assert.match(style, /\.purchase-amount \{ text-align:right; \}/);
  assert.match(style, /\.receipt-edit,\.receipt-delete \{ display:inline-flex;[^}]*border-color:var\(--line\);[^}]*color:var\(--muted\);/);
  assert.match(style, /\.receipt-delete:hover \{ border-color:var\(--danger\); background:var\(--danger-soft\); color:var\(--danger\); \}/);
  assert.match(style, /\.purchase-row>\.purchase-amount,\.purchase-row>\.receipt-action-buttons \{ grid-column:1\/-1; \}/);
  assert.match(app, /document\.querySelectorAll\("\[data-edit-receipt\]"\)/);
  assert.match(app, /function editReceipt\(id\)/);
  assert.match(app, /canManageReceipt\(purchase, session\.user\.id, isOwner\(\), active\(\)\)/);
  assert.match(app, /mode === "edit" && editingPurchase/);
  assert.match(app, /receiptEditChanges\(editingPurchase,/);
  assert.match(app, /supabase\.from\("purchases"\)\.update\(changes\)\.eq\("id", editingPurchase\.id\)\.eq\("household_id", current\.id\)/);
  assert.match(app, /if \(!isOwner\(\)\) request = request\.eq\("paid_by", session\.user\.id\)/);
  assert.match(app, /This receipt can only be edited by its payer or the household owner/);
  assert.match(app, /Reviewed items and their reconciled total stay unchanged/);
  assert.match(app, /\$\("amount"\)\.readOnly = itemized/);
  assert.match(app, /Discard your unsaved receipt changes/);
  assert.doesNotMatch(app, /confirm\("Remove this receipt/);
  assert.match(page, /id="remove-receipt" class="remove-receipt-dialog"[^>]*aria-labelledby="remove-receipt-title"[^>]*aria-describedby="remove-receipt-copy"/);
  assert.match(page, /id="keep-receipt"[^>]*>Keep receipt<\/button>/);
  assert.match(page, /id="confirm-remove-receipt"[^>]*class="danger"[^>]*>Remove receipt<\/button>/);
  assert.match(page, /stop affecting balances and Possible Buys[^<]*restorable from Household settings/);
  assert.match(app, /function deleteReceipt\(id\) \{[\s\S]*showModal\(\);[\s\S]*\$\("keep-receipt"\)\.focus\(\)/);
  assert.match(app, /function confirmRemoveReceipt\(\) \{[\s\S]*delete_purchase_receipt/);
  assert.match(app, /addEventListener\("cancel", event => \{ event\.preventDefault\(\); keepReceipt\(\); \}\)/);
  assert.match(app, /addEventListener\("click", event => \{ if \(event\.target === \$\("remove-receipt"\)\) keepReceipt\(\); \}\)/);
  assert.match(app, /rememberRemovedReceipt\(sessionStorage, current\.id, session\.user\.id, id\)/);
  assert.match(app, /id="undo-receipt-removal"/);
  assert.match(app, /restoreRemovedReceipt\(event\.currentTarget\.dataset\.receiptId, "undo"\)/);
  assert.match(app, /id="settings-recovery-title">Receipt recovery/);
  assert.match(app, /No removed receipts or archived settlements/);
  assert.match(app, /Restore to ledger/);
  assert.doesNotMatch(app, />Delete receipt</);
  assert.match(migration, /receipt_deleted/);
  assert.match(migration, /receipt_restored/);
  assert.match(migration, /Only the payer or household owner can delete this receipt/);
  assert.match(migration, /guard_purchase_receipt_lifecycle/);
  assert.match(migration, /revoke delete on public\.purchases from anon, authenticated/);
});
