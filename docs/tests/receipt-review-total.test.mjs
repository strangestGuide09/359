import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withItemSumReviewAmount } from "../receipt-review-total.js";

const unresolved = items => ({
  defaults: { amount: "", label: "Receipt" },
  items,
  totalConfidence: "low",
  parserWarning: "We could not confidently identify a final paid or payable total."
});

test("valid reviewed line totals prefill a clearly unconfirmed calculated amount", () => {
  const result = withItemSumReviewAmount(unresolved([{ line_total: 80 }, { line_total: 145.5 }]));
  assert.equal(result.defaults.amount, "225.50");
  assert.equal(result.totalConfidence, "item-sum");
  assert.equal(result.amountSource, "item-sum");
  assert.match(result.parserWarning, /Calculated from item totals.*verify against the receipt/i);
  assert.doesNotMatch(result.parserWarning, /confidently identify/);
});

test("invalid, non-positive, confirmed, or structurally unreliable totals are never synthesized", () => {
  assert.equal(withItemSumReviewAmount(unresolved([{ line_total: null }])).defaults.amount, "");
  assert.equal(withItemSumReviewAmount(unresolved([{ line_total: -1 }, { line_total: 20 }])).defaults.amount, "");
  assert.equal(withItemSumReviewAmount(unresolved([{ line_total: 0 }])).defaults.amount, "");
  assert.equal(withItemSumReviewAmount({ ...unresolved([{ line_total: 20 }]), defaults: { amount: "19.00" } }).defaults.amount, "19.00");
  assert.equal(withItemSumReviewAmount({ ...unresolved([{ line_total: 20 }]), parserWarning: "The rows do not reconcile." }).defaults.amount, "");
});

test("review UI labels item-sum amounts distinctly and item edits revalidate the confirmation", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /withItemSumReviewAmount\(\{/);
  assert.match(app, /Calculated from item totals — verify against receipt/);
  assert.match(app, /pendingPdfImport\?\.amountSource === "item-sum"/);
  assert.match(app, /resetReceiptReviewConfirmation\(true\)/);
  assert.match(app, /pendingPdfImport\.amountSource = "edited"/);
  assert.match(app, /\["high", "calculated"\]\.includes\(draftReference\.totalConfidence\)/);
});
