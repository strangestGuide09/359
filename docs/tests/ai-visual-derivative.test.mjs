import assert from "node:assert/strict";
import test from "node:test";
import { planVisualDerivative, VISUAL_JPEG_QUALITY, VISUAL_RENDER_SCALE } from "../ai-visual-derivative.js";

const pageSize = { width: 600, height: 800 };
const token = (text, x, y, width = 40, height = 10) => ({ text, x, y, width, height });
const safeTable = [
  token("Customer address outside table", 48, 750, 220),
  token("1", 20, 650, 8), token("Fresh milk 500 ml", 70, 650, 150), token("1", 330, 650, 8), token("65.00", 535, 650, 42),
  token("2", 20, 610, 8), token("Malai Paneer 200 g", 70, 610, 170), token("1", 330, 610, 8), token("145.00", 535, 610, 48),
  token("Total", 20, 110, 35), token("2", 330, 110, 8), token("210.00", 535, 110, 48)
];
const cellIncludes = (crop, target) => crop.cells.some(cell => target.x >= cell.x && target.x + target.width <= cell.x + cell.width && target.y >= cell.y && target.y + target.height <= cell.y + cell.height);

test("recognized Blinkit and Instamart row geometry is eligible for automatic visual derivatives", () => {
  for (const merchant of ["Blinkit", "Instamart"]) {
    const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant, itemCount: 2 });
    assert.equal(plan?.known, true);
    assert.equal(plan?.confidence, "high");
    assert.match(plan?.layoutKey || "", new RegExp(`:${merchant.toLowerCase()}:`));
    assert.equal(plan?.crops.length, 1);
  }
});

test("cell masks retain original raster detail without requiring header words", () => {
  const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant: "Blinkit", itemCount: 2 });
  assert.equal(VISUAL_RENDER_SCALE, 2.5);
  assert.equal(VISUAL_JPEG_QUALITY, 0.94);
  assert.ok(plan.crops[0].cells.length >= 8);
  assert.equal(cellIncludes(plan.crops[0], safeTable[2]), true);
  assert.equal(cellIncludes(plan.crops[0], safeTable[0]), false, "customer content outside item rows is masked");
  assert.equal(cellIncludes(plan.crops[0], safeTable.at(-1)), false, "aggregate footer is masked");
});

test("page-local serials may restart while multiline continuation descriptions remain intact", () => {
  const page = (start, lastName, subtotal) => [
    token(String(start), 20, 188, 8), token("Everyday Apple", 70, 188, 120), token("(Pack)", 70, 176, 42), token("2", 330, 188, 8), token("100.00", 535, 188, 48),
    token(String(start + 1), 20, 146, 8), token(lastName, 70, 146, 260), token("1", 330, 146, 8), token("145.00", 535, 146, 48),
    token("Total", 20, 110, 35), token("4", 330, 110, 8), token(subtotal, 535, 110, 48)
  ];
  const pages = [page(1, "Akshayakalpa Malai Paneer", "292.00"), page(1, "Akshayakalpa Set Cup Curd", "603.00")];
  const plan = planVisualDerivative({ pages, pageSizes: [pageSize, pageSize], merchant: "Blinkit", itemCount: 4 });
  assert.equal(plan.crops.length, 2);
  assert.equal(plan.confidence, "high");
  pages.forEach((tokens, index) => {
    assert.equal(cellIncludes(plan.crops[index], tokens[2]), true, `page ${index + 1} multiline description retained`);
    assert.equal(cellIncludes(plan.crops[index], tokens[6]), true, `page ${index + 1} last product retained`);
    assert.equal(cellIncludes(plan.crops[index], tokens.at(-1)), false, `page ${index + 1} subtotal excluded`);
  });
});

test("serial-free merchant tables use repeated right amount geometry and ignore repeated charge rows", () => {
  const serialFree = [
    token("Private content above", 45, 750, 150),
    token("Fresh milk 500 ml", 70, 610, 150), token("1", 250, 610, 8), token("65.00", 535, 610, 42),
    token("Delivery", 70, 585, 48), token("and other", 120, 585, 58), token("charges", 180, 585, 45), token("0.00", 535, 585, 36),
    token("Malai Paneer 200 g", 70, 550, 170), token("1", 250, 550, 8), token("145.00", 535, 550, 48),
    token("Delivery and other", 70, 525, 120), token("0.00", 535, 525, 36),
    token("Total", 70, 110, 35), token("210.00", 535, 110, 48)
  ];
  const plan = planVisualDerivative({ pages: [serialFree], pageSizes: [pageSize], merchant: "Blinkit", itemCount: 2 });
  assert.equal(plan?.known, true);
  assert.equal(plan?.crops[0].evidence, "amount-column");
  assert.equal(plan?.crops[0].rowCount, 2);
  assert.equal(cellIncludes(plan.crops[0], serialFree[1]), true);
  assert.equal(cellIncludes(plan.crops[0], serialFree.at(-1)), false, "summary total stays masked");
});

test("non-table pages are omitted and retain their original PDF page numbers", () => {
  const plan = planVisualDerivative({ pages: [safeTable, [token("Terms only", 50, 700, 80)]], pageSizes: [pageSize, pageSize], merchant: "Blinkit", itemCount: 2 });
  assert.deepEqual(plan?.crops.map(crop => crop.pageNumber), [1]);
  assert.equal(plan?.known, true);
});

test("unfamiliar but coherent geometry requires local approval", () => {
  const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant: "Neighbourhood Grocer", itemCount: 2 });
  assert.equal(plan?.known, false);
  assert.equal(plan?.confidence, "high");
  assert.match(plan?.layoutKey || "", /:new:/);
});

test("broken, private, or materially incomplete layouts fail closed", () => {
  const privateRow = safeTable.map(value => ({ ...value }));
  privateRow[2].text = "Delivery address: 359 Example Street";
  assert.equal(planVisualDerivative({ pages: [privateRow], pageSizes: [pageSize], merchant: "Blinkit", itemCount: 2 }), undefined);
  assert.equal(planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant: "Blinkit", itemCount: 8 }), undefined);
  assert.equal(planVisualDerivative({ pages: [[token("Milk", 70, 600, 80)]], pageSizes: [pageSize], merchant: "Blinkit", itemCount: 1 }), undefined);
  assert.equal(planVisualDerivative({ pages: [safeTable], pageSizes: [{ width: 0, height: 800 }], merchant: "Blinkit", itemCount: 2 }), undefined);
});
