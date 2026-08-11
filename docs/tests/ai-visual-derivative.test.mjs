import assert from "node:assert/strict";
import test from "node:test";
import { planVisualDerivative, VISUAL_JPEG_QUALITY, VISUAL_RENDER_SCALE } from "../ai-visual-derivative.js";

const pageSize = { width: 600, height: 800 };
const safeTable = [
  { text: "Description", x: 56, y: 700, height: 10 },
  { text: "Qty", x: 315, y: 700, height: 10 },
  { text: "Total", x: 520, y: 700, height: 10 },
  { text: "Fresh milk", x: 56, y: 650, height: 9 },
  { text: "Total", x: 48, y: 110, height: 10 }
];

test("recognized Blinkit and Instamart item tables are eligible for automatic local visual derivatives", () => {
  for (const merchant of ["Blinkit", "Instamart"]) {
    const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant });
    assert.equal(plan?.known, true);
    assert.match(plan?.layoutKey || "", new RegExp(`:${merchant.toLowerCase()}:`));
    assert.equal(plan?.crops.length, 1);
  }
});

test("dense invoice tables retain readable raster detail and description padding", () => {
  const plan = planVisualDerivative({ pages: [safeTable], pageSizes: [pageSize], merchant: "Blinkit" });
  assert.equal(VISUAL_RENDER_SCALE, 2.5);
  assert.equal(VISUAL_JPEG_QUALITY, 0.94);
  assert.ok(plan.crops[0].x <= 38, "description column keeps at least 3% page-width left padding");
});

test("crop excludes address above and amount-in-words below while retaining item descriptions", () => {
  const tokens = [
    { text: "Delivery Address: Ritesh, 359 Example Street", x: 48, y: 735, height: 10 },
    { text: "Item Description", x: 74, y: 700, height: 10 },
    { text: "Qty", x: 330, y: 700, height: 10 },
    { text: "Total", x: 535, y: 700, height: 10 },
    { text: "Akshayakalpa Organic Malai Paneer (Pack)", x: 68, y: 650, height: 9 },
    { text: "Everyday Apple (Pack)", x: 68, y: 610, height: 9 },
    { text: "Total", x: 48, y: 110, height: 10 },
    { text: "Amount in Words: Two Thousand Three Hundred Rupees Only", x: 48, y: 82, height: 10 }
  ];
  const crop = planVisualDerivative({ pages: [tokens], pageSizes: [pageSize], merchant: "Blinkit" }).crops[0];
  const withinVerticalCrop = token => token.y >= crop.y && token.y + token.height <= crop.y + crop.height;
  assert.equal(withinVerticalCrop(tokens[0]), false, "address above header is excluded");
  assert.equal(withinVerticalCrop(tokens.at(-1)), false, "spelled total below footer is excluded");
  assert.equal(withinVerticalCrop(tokens[4]), true);
  assert.equal(withinVerticalCrop(tokens[5]), true);
  assert.ok(crop.x <= tokens[4].x, "full description column remains inside the crop");
  assert.ok(crop.y > 120, "crop begins above the complete footer glyph row");
  assert.equal(crop.y + crop.height, 710, "crop ends at the header glyph boundary without upper-page padding");
});

test("ForwardInvoice page subtotal rows are excluded without clipping the last products", () => {
  const forwardPage = ({ quantity, amount, lastName }) => [
    { text: "Item Description", x: 74, y: 700, height: 10 },
    { text: "Qty", x: 330, y: 700, height: 10 },
    { text: "Total", x: 535, y: 700, height: 10 },
    { text: "Everyday Apple (Pack)", x: 74, y: 188, height: 9 },
    { text: lastName, x: 74, y: 146, height: 9 },
    { text: "Total", x: 48, y: 110, height: 10 },
    { text: String(quantity), x: 330, y: 109, height: 10 },
    { text: amount, x: 535, y: 111, height: 10 },
    { text: "Amount in Words", x: 48, y: 82, height: 10 }
  ];
  const pages = [
    forwardPage({ quantity: 4, amount: "₹292", lastName: "Akshayakalpa Organic Malai Paneer (Pack)" }),
    forwardPage({ quantity: 7, amount: "₹603", lastName: "Akshayakalpa Organic Set Cup Curd (Cup)" })
  ];
  const plan = planVisualDerivative({ pages, pageSizes: [pageSize, pageSize], merchant: "Blinkit" });
  assert.equal(plan.crops.length, 2);

  pages.forEach((tokens, pageIndex) => {
    const crop = plan.crops[pageIndex];
    const included = token => token.y >= crop.y && token.y + token.height <= crop.y + crop.height;
    assert.equal(included(tokens[4]), true, `page ${pageIndex + 1} last real product remains visible`);
    assert.equal(included(tokens[5]), false, `page ${pageIndex + 1} Total footer label is excluded`);
    assert.equal(included(tokens[6]), false, `page ${pageIndex + 1} aggregate quantity is excluded`);
    assert.equal(included(tokens[7]), false, `page ${pageIndex + 1} aggregate amount is excluded`);
  });
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
