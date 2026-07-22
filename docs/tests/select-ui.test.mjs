import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("expense metadata retains native labelled selects in one shared grid", async () => {
  const page = await read("docs/index.html");
  assert.match(page, /class="two expense-meta-grid"/);
  assert.match(page, /<label for="category">Category<select id="category">/);
  assert.match(page, /<label for="paid-by">Paid by<\/label><select id="paid-by" required aria-describedby="paid-by-help">/);
  assert.equal((page.match(/<select /g) || []).length, 2);
  assert.doesNotMatch(page, /role="(?:listbox|option)"/);
});

test("all native selects share fixed geometry and a token-based chevron", async () => {
  const style = await read("docs/style.css");
  assert.match(style, /select \{ height:48px; min-height:48px;/);
  assert.match(style, /appearance:none; -webkit-appearance:none;/);
  assert.match(style, /background-image:linear-gradient\(45deg,transparent 50%,var\(--pine\) 50%\),linear-gradient\(135deg,var\(--pine\) 50%,transparent 50%\)/);
  assert.match(style, /padding:10px 42px 10px 12px/);
  assert.match(style, /text-overflow:ellipsis; white-space:nowrap/);
  assert.match(style, /html\[data-presentation="sketch"\] select \{ border-color:var\(--pine\); box-shadow:none; \}/);
});

test("Paid by help stays below its control and metadata stacks on mobile", async () => {
  const [page, style] = await Promise.all([read("docs/index.html"), read("docs/style.css")]);
  assert.match(page, /<select id="paid-by"[^>]*><\/select><small id="paid-by-help">/);
  assert.match(style, /\.expense-meta-grid \{ align-items:start; \}/);
  assert.match(style, /\.field-with-help \{ display:grid; gap:6px; min-width:0;/);
  assert.match(style, /\.dialog-help:empty \{ display:none; \}/);
  assert.match(style, /@media \(max-width:700px\)[\s\S]*\.two,\.name-form,\.inline-form,\.command-bar,\.insights-grid \{ grid-template-columns:1fr; \}/);
});
