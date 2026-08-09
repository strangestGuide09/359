import assert from "node:assert/strict";
import test from "node:test";
import { canManageReceipt, receiptEditChanges } from "../receipt-actions.js";

test("only the payer or owner sees active receipt actions", () => {
  const receipt = { paid_by: "payer" };
  assert.equal(canManageReceipt(receipt, "payer", false, true), true);
  assert.equal(canManageReceipt(receipt, "partner", true, true), true);
  assert.equal(canManageReceipt(receipt, "partner", false, true), false);
  assert.equal(canManageReceipt(receipt, "payer", false, false), false);
});

test("manual receipt edits update all editable receipt fields", () => {
  assert.deepEqual(receiptEditChanges({ purchase_items: [] }, {
    label: "Corner shop", category: "Groceries", paidBy: "payer", purchasedOn: "2026-08-09", amount: 125, personal: true
  }), {
    label: "Corner shop", category: "Groceries", paid_by: "payer", purchased_on: "2026-08-09",
    amount: 125, is_personal: true, is_tracked_for_restock: false, estimated_use_by: null
  });
});

test("itemized receipt edits cannot desynchronize its reviewed amount or allocation", () => {
  const changes = receiptEditChanges({ purchase_items: [{ id: "item-1", line_total: 80 }] }, {
    label: "Instamart", category: "Groceries", paidBy: "payer", purchasedOn: "2026-08-09", amount: 999, personal: true
  });
  assert.deepEqual(changes, { label: "Instamart", category: "Groceries", paid_by: "payer", purchased_on: "2026-08-09" });
  assert.equal("amount" in changes, false);
  assert.equal("is_personal" in changes, false);
});
