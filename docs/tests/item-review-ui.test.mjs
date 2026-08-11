import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("receipt items render as compact rows with one expandable editor and no per-item acknowledgement", async () => {
  const [app, page] = await Promise.all([read("app.js"), read("index.html")]);
  assert.match(app, /<article class="item-row"/);
  assert.match(app, /class="item-checklist-row"/);
  assert.doesNotMatch(app, /data-reviewed|item\.reviewed/);
  assert.match(page, /id="confirm-receipt-review" type="checkbox" aria-describedby="item-total"/);
  assert.match(page, /id="confirm-receipt-review-copy">I reviewed all items and totals/);
  assert.match(app, /aria-expanded="\$\{expanded\}" aria-controls="item-editor-\$\{index\}"/);
  assert.match(app, /id="item-editor-\$\{index\}" class="item-editor"\$\{expanded \? "" : " hidden"\}/);
  assert.match(app, /expandedItemIndex = expandedItemIndex === index \? null : index/);
  assert.doesNotMatch(app, /<fieldset class="item-row"/);
});

test("expanded editor preserves every field and save requires receipt-level confirmation", async () => {
  const app = await read("app.js");
  for (const field of ["name", "quantity", "line_total", "is_personal", "is_tracked_for_restock", "unit", "unit_price", "estimated_use_by"]) {
    assert.match(app, new RegExp(`data-field="${field}"`), field);
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
