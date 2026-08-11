import assert from "node:assert/strict";
import test from "node:test";
import { planVisualDerivative } from "../ai-visual-derivative.js";

const pageSize = { width: 600, height: 800 };
const safeTable = [
  { text: "Description", x: 56, y: 700 },
  { text: "Qty", x: 315, y: 700 },
  { text: "Total", x: 520, y: 700 },
  { text: "Fresh milk", x: 56, y: 650 },
  { text: "Total", x: 48, y: 110 }
];

test("recognized Blinkit and Instamart item tables are eligible for automatic local visual derivatives", () => {
  for (const merchant of ["Blinkit", "Instamart"]) {
    const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant });
    assert.equal(plan?.known, true);
    assert.match(plan?.layoutKey || "", new RegExp(`:${merchant.toLowerCase()}:`));
    assert.equal(plan?.crops.length, 1);
  }
});

test("an unfamiliar safe layout requires a locally remembered approval", () => {
  const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant: "Neighbourhood Grocer" });
  assert.equal(plan?.known, false);
  assert.match(plan?.layoutKey || "", /:new:/);
});

test("a visual derivative is never planned unless each page independently has a bounded item table", () => {
  const missingFooter = safeTable.filter(token => !(token.text === "Total" && token.y === 110));
  assert.equal(planVisualDerivative({ pages: [safeTable, missingFooter], pageSizes: [pageSize, pageSize], merchant: "Blinkit" }), undefined);
  assert.equal(planVisualDerivative({ pages: [safeTable], pageSizes: [{ width: 0, height: 800 }], merchant: "Blinkit" }), undefined);
});
