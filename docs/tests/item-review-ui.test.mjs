import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("receipt items render as compact reviewed checklist rows with one expandable editor", async () => {
  const app = await read("app.js");
  assert.match(app, /<article class="item-row\$\{item\.reviewed \? " reviewed" : ""\}"/);
  assert.match(app, /class="item-checklist-row"/);
  assert.match(app, /data-reviewed type="checkbox"/);
  assert.match(app, /aria-expanded="\$\{expanded\}" aria-controls="item-editor-\$\{index\}"/);
  assert.match(app, /id="item-editor-\$\{index\}" class="item-editor"\$\{expanded \? "" : " hidden"\}/);
  assert.match(app, /expandedItemIndex = expandedItemIndex === index \? null : index/);
  assert.doesNotMatch(app, /<fieldset class="item-row"/);
});

test("expanded editor preserves every editable reviewed-item field and save requires review", async () => {
  const app = await read("app.js");
  for (const field of ["name", "quantity", "line_total", "is_personal", "is_tracked_for_restock", "unit", "unit_price", "estimated_use_by"]) {
    assert.match(app, new RegExp(`data-field="${field}"`), field);
  }
  assert.match(app, /reviewedItems\.some\(item => !item\.reviewed\)/);
  assert.match(app, /Mark every item as reviewed before saving this receipt/);
  assert.doesNotMatch(app, /reviewed:\s*!!item\.reviewed[\s\S]*p_items/);
});

test("compact checklist has dense desktop geometry and explicit mobile reflow", async () => {
  const style = await read("style.css");
  assert.match(style, /\.item-checklist-row \{ display:grid; grid-template-columns:92px 28px minmax\(220px,1fr\) 70px 110px 72px;/);
  assert.match(style, /\.item-row\.reviewed \{ border-left:4px solid var\(--pine\); \}/);
  assert.match(style, /\.item-checklist-row \{ grid-template-columns:82px 26px minmax\(0,1fr\) 72px;/);
  assert.match(style, /\.item-checklist-row \.edit-item \{ grid-column:1\/-1; width:100%; \}/);
});
