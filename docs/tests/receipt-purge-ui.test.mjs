import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("permanent deletion appears only for owner-visible removed purchases", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /const archivedEntries = \[\.\.\.ledger\.archivedPurchases/);
  assert.match(app, /active\(\) && isOwner\(\) && item\.type === "purchase" \? `<button class="archive-purge" data-purge-receipt=/);
  assert.match(app, /<div class="archived-entry-actions">\$\{restore\}\$\{purge\}<\/div>/);
  assert.match(app, /const restore = canRestore \? `<button class="secondary" data-restore-entry=/);
  assert.match(app, /document\.querySelectorAll\("\[data-purge-receipt\]"\)/);
  assert.doesNotMatch(app, /purchase-row[\s\S]{0,500}data-purge-receipt/);
  assert.match(app, /function requestReceiptPurge\(id\) \{[\s\S]*ledger\.archivedPurchases\.find[\s\S]*!active\(\) \|\| !isOwner\(\)/);
  assert.match(app, /function confirmReceiptPurge\(\) \{[\s\S]*if \(!id \|\| !isOwner\(\)\) return/);
});

test("hard-delete confirmation is app-styled, irreversible, and safely dismissible", async () => {
  const [page, app, style] = await Promise.all([read("docs/index.html"), read("docs/app.js"), read("docs/style.css")]);
  assert.match(page, /<dialog id="purge-receipt"[^>]*aria-labelledby="purge-receipt-title"[^>]*aria-describedby="purge-receipt-copy"/);
  assert.match(page, /Delete this receipt permanently\?/);
  assert.match(page, /permanently deleted\. It cannot be restored or undone/);
  assert.match(page, /id="keep-removed-receipt"[^>]*class="secondary"[^>]*>Keep receipt<\/button>/);
  assert.match(page, /id="confirm-purge-receipt"[^>]*class="danger"[^>]*>Delete permanently<\/button>/);
  assert.match(app, /requestAnimationFrame\(\(\) => \$\("keep-removed-receipt"\)\.focus\(\)\)/);
  assert.match(app, /purge-receipt"\)\.addEventListener\("cancel", event => \{ event\.preventDefault\(\); keepRemovedReceipt\(\); \}\)/);
  assert.match(app, /purge-receipt"\)\.addEventListener\("click", event => \{ if \(event\.target === \$\("purge-receipt"\)\) keepRemovedReceipt\(\); \}\)/);
  assert.match(style, /\.archive-purge \{ border-color:var\(--danger\); background:var\(--paper\); color:var\(--danger\); \}/);
});

test("confirmed purge uses the expected RPC and clears stale undo only after success", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /supabase\.rpc\("purge_purchase_receipt", \{ p_purchase_id: id \}\)/);
  assert.match(app, /if \(error\) \{ \$\("purge-receipt-error"\)\.textContent = error\.message; return; \}/);
  assert.match(app, /function confirmReceiptPurge\(\) \{[\s\S]*if \(error\) \{ \$\("purge-receipt-error"\)\.textContent = error\.message; return; \}[\s\S]*forgetRemovedReceipt\(sessionStorage, id\);[\s\S]*lastPdfFeedback = undefined;[\s\S]*clearImportFeedback\(document\);[\s\S]*await loadLedger\(\)/);
  assert.doesNotMatch(app, /confirm\([^\n]*Delete permanently/);
});
