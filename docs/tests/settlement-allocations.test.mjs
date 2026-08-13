import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { receiptSettlementAllocations } from "../settlement-allocations.js";

const purchases = [
  { id: "receipt-a", paid_by: "receiver", purchased_on: "2026-07-01", shared_amount: 200 },
  { id: "receipt-b", paid_by: "receiver", purchased_on: "2026-07-10", shared_amount: 300 },
  { id: "personal", paid_by: "receiver", purchased_on: "2026-07-01", shared_amount: 0 },
  { id: "other-payer", paid_by: "payer", purchased_on: "2026-07-01", shared_amount: 500 }
];

test("payments allocate oldest active receiver-paid shared receipts first", () => {
  assert.deepEqual(receiptSettlementAllocations({ purchases, existingAllocations: [], receiver: "receiver", amount: 180, settledOn: "2026-07-20" }), [
    { purchase_id: "receipt-a", purchase_item_id: null, amount: 100 },
    { purchase_id: "receipt-b", purchase_item_id: null, amount: 80 }
  ]);
});

test("existing allocations, personal receipts, other payers and later receipts are excluded", () => {
  const existingAllocations = [{ settlement_id: "old", purchase_id: "receipt-a", amount: 75 }];
  assert.deepEqual(receiptSettlementAllocations({ purchases, existingAllocations, receiver: "receiver", amount: 25, settledOn: "2026-07-05" }), [
    { purchase_id: "receipt-a", purchase_item_id: null, amount: 25 }
  ]);
  assert.deepEqual(receiptSettlementAllocations({ purchases, existingAllocations, receiver: "receiver", amount: 26, settledOn: "2026-07-05" }), [], "an unsupported remainder fails closed");
});

test("a payment without sufficient authoritative receipt capacity cannot be submitted", () => {
  assert.deepEqual(receiptSettlementAllocations({ purchases: [], existingAllocations: [], receiver: "receiver", amount: 50, settledOn: "2026-07-20" }), []);
  assert.deepEqual(receiptSettlementAllocations({ purchases, existingAllocations: [], receiver: "receiver", amount: 1, settledOn: "2026-06-30" }), []);
});

test("website history and writes use the receipt-backed database contract", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /from\("receipt_backed_settlement_history"\)\.select\("\*"\)/);
  assert.match(app, /settlements: settlementResult\.data\.filter\(settlement => Number\(settlement\.amount\) > 0\)/);
  assert.match(app, /record_receipt_backed_settlement/);
  assert.match(app, /active receipt allocation/);
  assert.doesNotMatch(app, /from\("settlements"\)\.insert/);
  assert.match(app, /delete_purchase_receipt[\s\S]*await loadLedger\(\)/);
  assert.match(app, /restore_purchase_receipt[\s\S]*await loadLedger\(\)/);
});
