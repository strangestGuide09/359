import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { cleanImportedItemName } from "../imported-item-name.js";

test("HSN labels are removed without damaging product, brand, or pack information", () => {
  assert.equal(cleanImportedItemName("Tata Sampann Kala Chana 500 g (HSN-07133100)"), "Tata Sampann Kala Chana 500 g");
  assert.equal(cleanImportedItemName("Akshayakalpa Paneer HSN-04061000 200 g"), "Akshayakalpa Paneer 200 g");
  assert.equal(cleanImportedItemName("Organic Rajma ( hSn - 07133300 ) (Pack)"), "Organic Rajma (Pack)");
  assert.equal(cleanImportedItemName("7UP 500 ml HSN : 22021010"), "7UP 500 ml");
});

test("a classification-only value becomes empty and cannot masquerade as a product", () => {
  assert.equal(cleanImportedItemName("(HSN-07133100)"), "");
  assert.equal(cleanImportedItemName("HSN-07133100"), "");
});

test("reviewed import persistence cleans names and retains empty-name validation", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /name: cleanImportedItemName\(item\.name\)/);
  assert.match(app, /if \(!items\.length \|\| items\.some\(item => !item\.name\)\)/);
});
