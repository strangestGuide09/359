import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRestockKey, qualifiesForRestockSuggestion, restockEmptyState, restockHistory } from "../restock.js";

const purchase = (date, items) => ({ purchased_on: date, purchase_items: items });
const tracked = (name, extra = {}) => ({ name, is_personal: false, is_tracked_for_restock: true, ...extra });

test("merchant and pack formatting variations share one deterministic restock key", () => {
  const groups = restockHistory([
    purchase("2026-07-01", [tracked("1. Instamart Desi Tomato (Pack) 500 grams")]),
    purchase("2026-07-12", [tracked("Blinkit - Desi Tomato 500g pack")])
  ]);
  assert.equal(groups.size, 1);
  assert.equal(qualifiesForRestockSuggestion([...groups.values()][0]), true);
  assert.equal(canonicalRestockKey("7UP 750 ml"), "7up 750ml");
});

test("same-day repeats do not qualify as a two-date suggestion", () => {
  const entries = [...restockHistory([purchase("2026-07-01", [tracked("Milk 500ml"), tracked("Milk 500 ml")])]).values()][0];
  assert.equal(qualifiesForRestockSuggestion(entries), false);
});

test("personal, untracked, and fee lines never enter restock history", () => {
  const groups = restockHistory([purchase("2026-07-01", [
    tracked("Personal tea", { is_personal: true }),
    tracked("Rice", { is_tracked_for_restock: false }),
    tracked("Platform fee")
  ])]);
  assert.equal(groups.size, 0);
});

test("genuinely distinct products and sizes do not merge", () => {
  const groups = restockHistory([purchase("2026-07-01", [tracked("Milk 500 ml"), tracked("Milk 1 litre"), tracked("Oat milk 500ml")])]);
  assert.equal(groups.size, 3);
});

test("common brand and pack-label variations group repeat groceries across dates", () => {
  const groups = restockHistory([
    purchase("2026-07-01", [tracked("Akshayakalpa Organic Malai Paneer (Pack) 200 grams"), tracked("Everyday Apple (Pack)")]),
    purchase("2026-07-18", [tracked("Amul Organic Malai Paneer 200g pack"), tracked("Fresh Apple pack")])
  ]);
  assert.equal(groups.size, 2);
  assert.ok([...groups.values()].every(qualifiesForRestockSuggestion));
});

test("only tracked non-personal grocery merchandise can suggest", () => {
  const groups = restockHistory([
    { ...purchase("2026-07-01", [tracked("Milk 1 L")]), category: "Food" },
    purchase("2026-07-01", [tracked("Delivery and other charges"), tracked("CGST tax"), tracked("Milk 1 L")]),
    purchase("2026-07-10", [tracked("Platform charge"), tracked("Milk 1 litre")])
  ]);
  assert.deepEqual([...groups.keys()], ["milk 1l"]);
  assert.equal(qualifiesForRestockSuggestion([...groups.values()][0]), true);
});

test("empty state states the exact distinct-date requirement", () => {
  const groups = restockHistory([purchase("2026-07-01", [tracked("Rice 2 kg"), tracked("Rice 2kg")])]);
  assert.equal(qualifiesForRestockSuggestion([...groups.values()][0]), false);
  assert.match(restockEmptyState(groups), /1 grocery item type across 1 purchase date/);
  assert.match(restockEmptyState(groups), /same normalized item is bought on a second date/);
  assert.match(restockEmptyState(new Map()), /keep Track for restock selected on merchandise/);
});
