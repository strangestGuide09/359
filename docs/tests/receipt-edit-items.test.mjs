import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("saved itemized receipts reopen the compact reviewed-item workflow", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /const savedItems = itemized \? savedPurchaseItemsForReview\(purchase\.purchase_items\) : \[\]/);
  assert.match(app, /openEntry\("edit",[\s\S]*itemized \? \{ items: savedItems, amountSource: "item-sum", savedEdit: true \}/);
  assert.match(app, /Review every saved item before updating/);
  assert.match(app, /Products, paid fees, tax, discounts, and rounding must reconcile/);
  assert.match(app, /Paid by stays fixed to preserve the receipt and settlement audit trail/);
  assert.match(app, /\$\("amount"\)\.readOnly = itemized/);
  assert.match(app, /\$\("paid-by"\)\.disabled = itemized/);
  assert.match(app, /if \(!receiptReviewConfirmed\)[\s\S]*reviewed all items and totals before updating/);
});

test("itemized edits preserve item identity and use one atomic RPC", async () => {
  const [app, state, store] = await Promise.all([read("docs/app.js"), read("docs/reviewed-item-state.js"), read("docs/reviewed-purchase-store.js")]);
  assert.match(state, /if \(includeId && normalized\.id\) payload\.id = normalized\.id/);
  assert.match(app, /reviewedItemsForSave\(true\)/);
  assert.match(app, /updateReviewedPurchase\(supabase, \{ p_purchase_id: editingPurchase\.id, p_label: label, p_category: \$\("category"\)\.value, p_purchased_on: \$\("date"\)\.value, p_items: items \}\)/);
  assert.match(store, /client\.rpc\("update_reviewed_purchase", values\)/);
  assert.doesNotMatch(app, /updateReviewedPurchase\([\s\S]{0,220}p_paid_by/);
  assert.doesNotMatch(app, /editingPurchase\.purchase_items[\s\S]{0,500}supabase\.from\("purchase_items"\)/);
  assert.match(app, /Products, fees, taxes, discounts, and rounding must reconcile/);
});

test("saved item changes reset confirmation and discard safely", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /\["label", "category", "paid-by", "date"\][\s\S]*resetReceiptReviewConfirmation/);
  assert.match(app, /Discard these receipt changes\?/);
  assert.match(app, /keep the saved receipt and remove only these unsaved edits/);
  assert.match(app, /editingPurchase && formDirty && !pendingPdfImport && !confirm/);
});
