import assert from "node:assert/strict";
import test from "node:test";
import { parseReceipt, receiptDate } from "../receipt-parser.js";

test("Instamart visual rows produce reviewed products and a clean merchant", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "TAX INVOICE" },
    { y: 780, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 740, text: "Description of Goods Quantity HSN Taxable Value Amount" },
    { y: 700, text: "Amul Taaza Homogenised Toned Milk 1 L" },
    { y: 680, text: "1 NOS 0401 61.90 2.50 2.50 0 65.00" },
    { y: 640, text: "Fresh Farm Tomatoes 500 g" },
    { y: 620, text: "2 NOS 0702 76.20 1.90 1.90 0 80.00" },
    { y: 120, text: "Invoice Value 145.00" },
    { y: 100, text: "Date of Invoice 03/07/2026" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.label, "Instamart");
  assert.equal(parsed.defaults.amount, "145.00");
  assert.equal(parsed.defaults.date, "2026-07-03");
  assert.deepEqual(parsed.items.map(item => item.name), [
    "Amul Taaza Homogenised Toned Milk 1 L",
    "Fresh Farm Tomatoes 500 g"
  ]);
  assert.deepEqual(parsed.items.map(item => item.line_total), [65, 80]);
  assert.deepEqual(parsed.items.map(item => item.quantity), [1, 2]);
  assert.ok(parsed.items.every(item => item.name.trim()), "review draft never contains a blank item");
});

test("Instamart combined product and quantity rows retain the product name", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 700, text: "Amul Gold Full Cream Milk 1 L 1.000 NOS 0401 65.00" },
    { y: 120, text: "Invoice Value 65.00" },
    { y: 100, text: "Date of Invoice 15/07/2026" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.label, "Instamart");
  assert.equal(parsed.defaults.amount, "65.00");
  assert.equal(parsed.defaults.date, "2026-07-15");
  assert.deepEqual(parsed.items.map(item => item.name), ["Amul Gold Full Cream Milk 1 L"]);
  assert.deepEqual(parsed.items.map(item => item.line_total), [65]);
});

test("payable total uses the amount beside its semantic label, not a later number", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 700, text: "Milk 1 NOS 0401 144.00" },
    { y: 680, text: "Rice 1 NOS 1006 593.02" },
    { y: 120, text: "Invoice Value ₹737.02 HSN Summary 144" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.amount, "737.02");
  assert.equal(parsed.totalConfidence, "high");
  assert.equal(parsed.parserWarning, "");
});

test("receipt-level discount is allocated across items to the final payable total", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 700, text: "Milk 1 NOS 0401 400.00" },
    { y: 680, text: "Rice 1 NOS 1006 471.00" },
    { y: 140, text: "Subtotal 871.00 Discount 133.98" },
    { y: 120, text: "Final Amount Payable ₹737.02 Reference 144" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.amount, "737.02");
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 737.02);
  assert.match(parsed.parserNotice, /discount of ₹133\.98 was allocated/);
  assert.equal(parsed.parserWarning, "");
});

test("unlabelled numeric fallback is explicitly low confidence", () => {
  const parsed = parseReceipt([[{ y: 100, text: "Corner Shop" }, { y: 80, text: "Rice 120.00" }]], "2026-07-16");
  assert.equal(parsed.defaults.amount, "120.00");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /could not identify a labelled payable total/i);
});

test("generic receipts still support name and price rows", () => {
  const parsed = parseReceipt([[
    { y: 100, text: "Corner Shop" },
    { y: 80, text: "Rice 120.00" },
    { y: 60, text: "Grand Total 120.00" }
  ]], "2026-07-16");
  assert.equal(parsed.defaults.label, "Corner Shop");
  assert.equal(parsed.defaults.amount, "120.00");
  assert.equal(parsed.items[0].name, "Rice");
  assert.equal(parsed.items[0].line_total, 120);
});

test("receipt dates use an explicit fallback when absent", () => {
  assert.equal(receiptDate("no date", "2026-07-16"), "2026-07-16");
});
