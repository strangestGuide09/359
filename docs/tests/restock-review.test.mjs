import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { focusRestockReceipt } from "../restock-review.js";

const row = id => ({
  dataset: { purchaseId: id }, classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } },
  scrollIntoViewOptions: null, focused: false,
  scrollIntoView(options) { this.scrollIntoViewOptions = options; }, focus() { this.focused = true; },
  addEventListener(name, callback) { this[`${name}Callback`] = callback; }
});

test("Review now focuses and identifies the matching receipt row", () => {
  const first = row("purchase-1");
  const target = row("purchase-2");
  const root = { querySelectorAll: () => [first, target] };
  assert.equal(focusRestockReceipt(root, "purchase-2"), true);
  assert.equal(target.focused, true);
  assert.equal(target.tabIndex, -1);
  assert.deepEqual(target.scrollIntoViewOptions, { behavior: "smooth", block: "center" });
  assert.equal(target.classList.values.has("restock-review-target"), true);
  target.blurCallback();
  assert.equal(target.classList.values.has("restock-review-target"), false);
});

test("a stale suggestion fails safely when its receipt is no longer active", () => {
  assert.equal(focusRestockReceipt({ querySelectorAll: () => [] }, "missing"), false);
});

test("due suggestions are buttons while future timing remains noninteractive", async () => {
  const [app, style] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../style.css", import.meta.url), "utf8")
  ]);
  assert.match(app, /<button type="button" class="restock-review" data-review-restock=/);
  assert.match(app, /aria-label="Review \$\{esc\(latest\.display_name\)\} in its latest receipt"/);
  assert.match(app, /<time class="restock-timing\$\{due <= today\(\) \? " due" : ""\}" datetime="\$\{due\}"/);
  assert.doesNotMatch(app, /<time class="[^"$]*due[^"$]*">\$\{due <= today\(\) \? "Review now"/);
  assert.match(app, /focusRestockReceipt\(document, button\.dataset\.reviewRestock\)/);
  assert.match(style, /\.restock-timing \{[^}]*font-weight:normal;/);
  assert.match(style, /\.restock-review \{[^}]*border-color:var\(--line\);/);
});
