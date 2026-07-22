import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("local PDF extraction preserves positioned tokens without persisting receipt text", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /page:\s*pageNumber/);
  assert.match(app, /x:\s*Number\(item\.transform\?\.\[4\]\)/);
  assert.match(app, /y:\s*Number\(item\.transform\?\.\[5\]\)/);
  assert.match(app, /width:\s*Number\(item\.width\)/);
  assert.match(app, /height:\s*Number\(item\.height\)/);
  assert.doesNotMatch(app, /const rows = new Map\(\)/);
  assert.doesNotMatch(app, /p_(?:pdf|raw|extracted|receipt_text)/i);
});

test("an unknown receipt total is not rendered as zero or a negative difference", async () => {
  const app = await read("docs/app.js");
  assert.match(app, /Receipt total: needs confirmation · Difference unavailable/);
  assert.match(app, /if \(!rawReceiptTotal\)/);
  assert.doesNotMatch(app, /const receiptTotal = Number\(\$\("amount"\)\.value\) \|\| 0/);
});
