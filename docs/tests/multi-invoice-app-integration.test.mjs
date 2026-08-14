import assert from "node:assert/strict";
import test from "node:test";
import { parseReceipt } from "../receipt-parser.js";
import { normalizeReviewedItem, reviewedItemsForSave, savedPurchaseItemsForReview } from "../reviewed-item-state.js";
import { renderReviewedItemRows } from "../reviewed-item-view.js";
import { importReviewedPurchase, loadReviewedPurchases, updateReviewedPurchase } from "../reviewed-purchase-store.js";

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

function mockSupabase() {
  const purchases = [];
  const client = {
    rpc: async (name, values) => {
      if (name === "import_reviewed_purchase") {
        const id = "purchase-871";
        purchases.push({ id, household_id: values.p_household_id, label: values.p_label, amount: values.p_amount, purchased_on: values.p_purchased_on, archived_at: null, purchase_items: values.p_items.map((item, index) => ({ ...item, id: `item-${index + 1}`, purchase_id: id })) });
        return { data: id, error: null };
      }
      if (name === "update_reviewed_purchase") {
        const purchase = purchases.find(item => item.id === values.p_purchase_id);
        purchase.label = values.p_label;
        purchase.purchased_on = values.p_purchased_on;
        purchase.amount = values.p_items.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
        purchase.purchase_items = values.p_items.map(item => ({ ...item, purchase_id: purchase.id }));
        return { data: purchase.id, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: table => {
      assert.equal(table, "purchases");
      const query = {
        select: selection => { assert.equal(selection, "*,purchase_items(*)"); return query; },
        eq: (field, value) => { assert.equal(field, "household_id"); assert.equal(value, "household-1"); return query; },
        is: async (field, value) => ({ data: purchases.filter(item => item[field] === value), error: null }),
        not: async () => ({ data: [], error: null })
      };
      return query;
    }
  };
  return client;
}

test("actual app import/store/reopen path preserves the ₹871 two-invoice reviewed values", async () => {
  const client = mockSupabase();
  const parsed = parseReceipt(pages, "2026-08-13");
  assert.equal(Number(parsed.defaults.amount), 871);
  assert.equal(parsed.items.length, 11);

  const review = parsed.items.map(normalizeReviewedItem);
  const boondi = review.find(item => /Boondi/.test(item.name));
  const tea = review.find(item => /Chamomile/.test(item.name));
  boondi.is_personal = false;
  boondi.is_tracked_for_restock = true;
  tea.is_personal = true;
  tea.is_tracked_for_restock = false;
  const payloadItems = reviewedItemsForSave(review);
  assert.equal(payloadItems.reduce((sum, item) => sum + item.line_total, 0), 871);

  const imported = await importReviewedPurchase(client, { p_household_id: "household-1", p_paid_by: "ritesh", p_label: "Two seller invoice", p_amount: 871, p_purchased_on: "2026-08-13", p_items: payloadItems });
  assert.equal(imported.error, null);

  const firstLoad = await loadReviewedPurchases(client, "household-1");
  const reopened = savedPurchaseItemsForReview(firstLoad.data[0].purchase_items);
  assert.deepEqual(reopened.filter(item => /Boondi|Chamomile/.test(item.name)).map(item => [item.line_total, item.is_personal, item.is_tracked_for_restock]), [[75, false, true], [69, true, false]]);

  const updateItems = reviewedItemsForSave(reopened, true);
  const updated = await updateReviewedPurchase(client, { p_purchase_id: firstLoad.data[0].id, p_label: firstLoad.data[0].label, p_purchased_on: firstLoad.data[0].purchased_on, p_items: updateItems });
  assert.equal(updated.error, null);
  const secondLoad = await loadReviewedPurchases(client, "household-1");
  const reopenedAgain = savedPurchaseItemsForReview(secondLoad.data[0].purchase_items);
  assert.equal(reopenedAgain.reduce((sum, item) => sum + item.line_total, 0), 871);
  assert.deepEqual(reopenedAgain.filter(item => /Boondi|Chamomile/.test(item.name)).map(item => [item.line_total, item.is_personal, item.is_tracked_for_restock]), [[75, false, true], [69, true, false]]);

  const html = renderReviewedItemRows(reopenedAgain, value => `₹${Number(value).toFixed(2)}`);
  assert.match(html, /Boondi[^]*₹75\.00/);
  assert.match(html, /Calm Chamomile Tea[^]*₹69\.00/);
  assert.doesNotMatch(html, /114\.29|142\.86/);
});
