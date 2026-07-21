import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRestockKey, qualifiesForRestockSuggestion, restockHistory } from "../restock.js";

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
