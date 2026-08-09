import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRestockKey, isRestockMerchandise, qualifiesForRestockSuggestion, restockEligibility, restockEmptyGuidance, restockEmptyState, restockHistory } from "../restock.js";

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
  const { groups, stats } = restockEligibility([purchase("2026-07-01", [tracked("Rice 2 kg"), tracked("Rice 2kg")])]);
  assert.equal(qualifiesForRestockSuggestion([...groups.values()][0]), false);
  assert.match(restockEmptyState(groups, stats), /Tracking 1 grocery item type across 1 purchase date/);
  assert.match(restockEmptyState(groups, stats), /same item on 2 different dates/);
  assert.match(restockEmptyState(new Map()), /keep Track for restock selected on merchandise/);
});

test("empty guidance prioritizes the next action and keeps exclusions secondary", () => {
  const { groups, stats } = restockEligibility([purchase("2026-07-01", [tracked("Rice 2 kg"), tracked("Delivery fee")])]);
  const guidance = restockEmptyGuidance(groups, stats);
  assert.equal(guidance.title, "Buy a tracked item again to unlock suggestions");
  assert.match(guidance.next, /same item on 2 different dates/);
  assert.match(guidance.detail, /Excluded: 1 fee, tax, or delivery/);
});

test("audit-derived malformed Green Chilli rows normalize without admitting charge artifacts", () => {
  const deliveryArtifact = "- Delivery and other - - - 1.56 0.00 0.00 0.00 0 0.00";
  const clean = "Green Chilli (Hasiru Menasinakaayi)";
  const polluted = "8904 Green Chilli ( Pack ) 11.00 0.00 1 12.00 0.00 0.00 0.00 0.00 0.00";
  const { groups, stats } = restockEligibility([
    purchase("2026-07-05", [tracked(clean), tracked(deliveryArtifact)]),
    purchase("2026-07-16", [tracked(polluted), tracked(deliveryArtifact)])
  ]);

  assert.equal(canonicalRestockKey(clean), "green chilli");
  assert.equal(canonicalRestockKey(polluted), "green chilli");
  assert.equal(isRestockMerchandise(deliveryArtifact), false);
  assert.deepEqual([...groups.keys()], ["green chilli"]);
  assert.equal(qualifiesForRestockSuggestion(groups.get("green chilli")), true);
  assert.equal(groups.get("green chilli").at(-1).display_name, "Green Chilli");
  assert.equal(stats.excludedFees, 2);
  assert.equal(stats.qualifyingItems, 2);
});

test("normalization skips incomplete brand-only artifacts instead of fabricating product matches", () => {
  const incomplete = "8904 Tata Sampann 49.00 0.00 1 49.00 0.00 0.00 0.00 0.00 0.00";
  assert.equal(canonicalRestockKey(incomplete), "");
  assert.notEqual(canonicalRestockKey(incomplete), canonicalRestockKey("Tata Sampann Toor Dal 1kg"));
});

test("eligibility reason reports tracked candidates and categorical exclusions", () => {
  const { groups, stats } = restockEligibility([purchase("2026-07-16", [
    tracked("Green Chilli"),
    tracked("Delivery and other charges"),
    tracked("CGST 2.5%"),
    tracked("Paneer", { is_personal: true }),
    tracked("Rice", { is_tracked_for_restock: false })
  ])]);
  const message = restockEmptyState(groups, stats);
  assert.match(message, /Tracking 1 grocery item type across 1 purchase date/);
  assert.match(message, /0 items repeat on a second date/);
  assert.match(message, /Excluded: 2 fee, tax, or delivery · 1 personal · 1 untracked · 0 outside groceries/);
});
