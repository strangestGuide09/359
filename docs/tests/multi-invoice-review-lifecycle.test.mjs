import assert from "node:assert/strict";
import test from "node:test";
import { parseReceipt } from "../receipt-parser.js";
import { normalizeReviewedItem, reviewedItemsForSave, savedPurchaseItemsForReview } from "../reviewed-item-state.js";
import { renderReviewedItemRows } from "../reviewed-item-view.js";

const pages = [
  [
    { y: 800, text: "Tax Invoice Seller One" },
    { y: 700, text: "1. Boondi, Made in 1 NOS 2106 75.00" },
    { y: 680, text: "Rice 1 NOS 1006 150.00" },
    { y: 660, text: "Milk 1 NOS 0401 80.00" },
    { y: 640, text: "Oil 1 NOS 1512 175.00" },
    { y: 620, text: "Apples 1 NOS 0808 120.00" },
    { y: 600, text: "Paneer 1 NOS 0406 127.00" },
    { y: 120, text: "Invoice Value 727.00" }
  ],
  [
    { y: 800, text: "Tax Invoice Seller Two" },
    { y: 700, text: "2. Calm Chamomile Tea 1 NOS 0902 69.00" },
    { y: 680, text: "Bread 1 NOS 1905 15.00" },
    { y: 660, text: "Eggs 1 NOS 0407 30.00" },
    { y: 640, text: "Tomato 1 NOS 0702 15.00" },
    { y: 620, text: "Green Chilli 1 NOS 0709 15.00" },
    { y: 120, text: "Invoice Value 144.00" }
  ]
];

test("₹871 two-invoice values and flags survive review, RPC payload, load, and reopen", () => {
  const parsed = parseReceipt(pages, "2026-08-13");
  assert.equal(parsed.items.length, 11);
  const review = parsed.items.map(normalizeReviewedItem);
  const boondi = review.find(item => /Boondi/.test(item.name));
  const tea = review.find(item => /Chamomile Tea/.test(item.name));
  tea.is_personal = true;
  tea.is_tracked_for_restock = false;
  boondi.is_personal = false;
  boondi.is_tracked_for_restock = true;

  const payload = reviewedItemsForSave(review);
  assert.equal(payload.reduce((sum, item) => sum + item.line_total, 0), 871);
  assert.deepEqual(payload.filter(item => /Boondi|Chamomile/.test(item.name)).map(item => [item.name, item.line_total, item.is_personal, item.is_tracked_for_restock]), [
    [boondi.name, 75, false, true],
    [tea.name, 69, true, false]
  ]);

  const loadedRows = payload.map((item, index) => ({ ...item, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
  const reopened = savedPurchaseItemsForReview(loadedRows);
  assert.equal(reopened.reduce((sum, item) => sum + item.line_total, 0), 871);
  assert.deepEqual(reopened.filter(item => /Boondi|Chamomile/.test(item.name)).map(item => [item.name, item.line_total, item.is_personal, item.is_tracked_for_restock, item.id]), [
    [boondi.name, 75, false, true, loadedRows[0].id],
    [tea.name, 69, true, false, loadedRows[6].id]
  ]);

  const html = renderReviewedItemRows(reopened, value => `₹${Number(value).toFixed(2)}`);
  assert.match(html, /Boondi[^]*₹75\.00/);
  assert.match(html, /Calm Chamomile Tea[^]*₹69\.00/);
  assert.match(html, /Shared · Restock on/);
  assert.match(html, /Personal · Restock off/);
  assert.doesNotMatch(html, /114\.29|142\.86/);
});

test("multi-invoice products and paid fee survive review/save/reopen without price redistribution", () => {
  const parsedProducts = parseReceipt(pages, "2026-07-03").items;
  const review = [...parsedProducts, normalizeReviewedItem({
    name: "Handling fee", quantity: 1, unit_price: 11.99, line_total: 11.99,
    item_kind: "fee", is_personal: false, is_tracked_for_restock: true
  })].map(normalizeReviewedItem);
  const payload = reviewedItemsForSave(review);
  const boondi = payload.find(item => /Boondi/.test(item.name));
  const tea = payload.find(item => /Chamomile/.test(item.name));
  const fee = payload.find(item => item.item_kind === "fee");

  assert.equal(boondi.line_total, 75);
  assert.equal(tea.line_total, 69);
  assert.deepEqual(fee, {
    name: "Handling fee", quantity: 1, unit: null, unit_price: 11.99,
    line_total: 11.99, shared_line_total: 11.99, is_personal: false, is_tracked_for_restock: false,
    estimated_use_by: null, item_kind: "fee", include_in_total: true,
    display_order: 11
  });
  assert.equal(payload.reduce((sum, item) => sum + item.line_total, 0), 882.99);

  fee.is_personal = true;
  const reopened = savedPurchaseItemsForReview(payload.map((item, index) => ({ ...item, id: `item-${index}` })));
  assert.equal(reopened.at(-1).item_kind, "fee");
  assert.equal(reopened.at(-1).is_tracked_for_restock, false);
});
