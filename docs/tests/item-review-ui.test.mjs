import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("receipt items render as compact rows with one expandable editor and no per-item acknowledgement", async () => {
  const [app, view, page] = await Promise.all([read("app.js"), read("reviewed-item-view.js"), read("index.html")]);
  assert.match(view, /<article class="item-row\$\{/);
  assert.match(view, /class="item-checklist-row"/);
  assert.doesNotMatch(`${app}\n${view}`, /data-reviewed|item\.reviewed/);
  assert.match(page, /id="confirm-receipt-review" type="checkbox" aria-describedby="item-total"/);
  assert.match(page, /id="confirm-receipt-review-copy">I reviewed all items and totals/);
  assert.match(view, /aria-expanded="\$\{expanded\}" aria-controls="item-editor-\$\{index\}"/);
  assert.match(view, /id="item-editor-\$\{index\}" class="item-editor"\$\{expanded \? "" : " hidden"\}/);
  assert.match(app, /expandedItemIndex = expandedItemIndex === index \? null : index/);
  assert.doesNotMatch(app, /<fieldset class="item-row"/);
});

test("expanded editor preserves every field and save requires receipt-level confirmation", async () => {
  const [app, view] = await Promise.all([read("app.js"), read("reviewed-item-view.js")]);
  for (const field of ["name", "quantity", "line_total", "is_personal", "is_tracked_for_restock", "unit", "unit_price", "estimated_use_by"]) {
    assert.match(view, new RegExp(`data-field="${field}"`), field);
  }
  assert.match(app, /if \(!receiptReviewConfirmed\)/);
  assert.match(app, /Confirm that you reviewed all items and totals before saving this receipt/);
  assert.match(app, /\$\("confirm-receipt-review"\)\.focus\(\)/);
  assert.doesNotMatch(app, /reviewed:/);
});

test("editing, adding, removing, and changing the receipt total reset confirmation", async () => {
  const app = await read("app.js");
  assert.match(app, /function resetReceiptReviewConfirmation\(recalculateItemSum = false\) \{[\s\S]*receiptReviewConfirmed = false;[\s\S]*\$\("confirm-receipt-review"\)\.checked = false;/);
  assert.match(app, /querySelectorAll\("\[data-field\]"\)[\s\S]*input\.oninput = \(\) => \{[\s\S]*resetReceiptReviewConfirmation\(true\)/);
  assert.match(app, /\.remove-item"\)\.onclick = \(\) => \{[\s\S]*resetReceiptReviewConfirmation\(true\); renderItemRows\(\)/);
  assert.match(app, /\$\("add-item"\)\.onclick = \(\) => \{[\s\S]*resetReceiptReviewConfirmation\(true\); renderItemRows\(\)/);
  assert.match(app, /\$\("amount"\)\.oninput = \(\) => \{[\s\S]*resetReceiptReviewConfirmation\(\); updateItemTotal\(\); \}/);
  assert.match(app, /I reviewed all \$\{count\} \$\{count === 1 \? "item" : "items"\} and totals/);
});

test("compact checklist has dense desktop geometry and explicit mobile reflow", async () => {
  const style = await read("style.css");
  assert.match(style, /\.item-checklist-row \{ display:grid; grid-template-columns:28px minmax\(220px,1fr\) 70px 110px 72px;/);
  assert.match(style, /\.item-review-summary \{ position:sticky;/);
  assert.match(style, /\.receipt-review-confirmation \{ min-height:43px;/);
  assert.match(style, /\.item-checklist-row \{ grid-template-columns:26px minmax\(0,1fr\) 72px;/);
  assert.match(style, /\.item-checklist-row \.edit-item \{ grid-column:1\/-1; width:100%; \}/);
});

test("parsed paid fees stay explicit, shared by default, and never become restock items", async () => {
  const [app, state, view, style] = await Promise.all([read("app.js"), read("reviewed-item-state.js"), read("reviewed-item-view.js"), read("style.css")]);
  assert.match(state, /const kinds = new Set\(\["product", "fee", "tax", "discount", "credit", "rounding", "informational"\]\)/);
  assert.match(view, /const kindLabel = \(\{ fee: "Paid fee", tax: "Tax", discount: "Discount", credit: "Credit", rounding: "Rounding", informational: "Information" \}\)/);
  assert.doesNotMatch(view, /Include this fee in the ledger total/);
  assert.match(state, /include_in_total: normalized\.include_in_total/);
  assert.match(state, /return items\.map/);
  assert.match(state, /normalized\.item_kind === "product" && normalized\.include_in_total && !normalized\.is_personal/);
  assert.match(app, /Products: \$\{money\(productSum\)\} · Fees: \$\{money\(feeSum\)\} · Tax:/);
  assert.match(style, /\.item-row\.fee-row/);
  assert.doesNotMatch(view, /is_personal[^>]+disabled/);
});

test("mismatched review blocks save without silently changing product prices", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /Products, fees, taxes, discounts, and rounding must reconcile/);
  assert.match(app, /Product prices were not adjusted; resolve the displayed difference/);
  assert.doesNotMatch(app, /line_total\s*=.*difference|difference.*line_total/);
  assert.match(app, /Check component signs: products, fees, and additive tax are positive/);
});
