import assert from "node:assert/strict";
import test from "node:test";
import { cleanInstamartItemName, parseReceipt, receiptDate } from "../receipt-parser.js";

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
  assert.ok(parsed.items.every(item => item.is_tracked_for_restock), "parsed non-personal items default to restock tracking");
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

test("Instamart table columns are removed from nearby item names", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 710, text: "5512 Desi Tomato ( Pack ) 15.00 0.00 1 15.00 0.00 0.00 0.00 0.00 0.00 0.00" },
    { y: 700, text: "1 NOS 0702 15.00" },
    { y: 120, text: "Invoice Value 15.00" }
  ]], "2026-07-16");

  assert.deepEqual(parsed.items.map(item => item.name), ["Desi Tomato (Pack)"]);
});

test("Instamart name cleanup removes list numbering but preserves product numbers and sizes", () => {
  assert.equal(cleanInstamartItemName("1. Boondi, Made in"), "Boondi, Made in");
  assert.equal(cleanInstamartItemName("2. Calm Chamomile Tea"), "Calm Chamomile Tea");
  assert.equal(cleanInstamartItemName("Fresh Milk 500 ml"), "Fresh Milk 500 ml");
  assert.equal(cleanInstamartItemName("Basmati Rice 2 kg"), "Basmati Rice 2 kg");
  assert.equal(cleanInstamartItemName("7UP 750 ml"), "7UP 750 ml");
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

test("semantic total chooses the plausible payable column after an isolated fee value", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 700, text: "Milk 1 NOS 0401 100.00" },
    { y: 680, text: "Rice 1 NOS 1006 127.43" },
    { y: 640, text: "Delivery fee 1 NOS 9968 1.56" },
    { y: 120, text: "Grand Total items 13.00 paid ₹228.99" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.amount, "228.99");
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 228.99);
  assert.equal(parsed.totalConfidence, "high");
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

test("Instamart operational charges remain explicit untracked lines and summary rows are filtered", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 720, text: "Fresh Milk 500 ml" },
    { y: 700, text: "1 NOS 0401 100.00" },
    { y: 660, text: "Basmati Rice 2 kg" },
    { y: 640, text: "1 NOS 1006 127.43" },
    { y: 600, text: "- Delivery and other - - - 1.56 0.00 0.00 0.00 0 0.00" },
    { y: 580, text: "1 NOS 9968 1.56" },
    { y: 540, text: "CGST summary 0.00 0.00 0.00 0.00" },
    { y: 520, text: "1 NOS 0000 0.00" },
    { y: 140, text: "Total Discount 13.00" },
    { y: 120, text: "Amount Paid ₹228.99" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.amount, "228.99");
  assert.deepEqual(parsed.items.map(item => item.name), ["Fresh Milk 500 ml", "Basmati Rice 2 kg", "Delivery and other charges"]);
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 228.99);
  const charge = parsed.items.find(item => item.name === "Delivery and other charges");
  assert.equal(charge.line_total, 1.56);
  assert.equal(charge.is_tracked_for_restock, false);
  assert.doesNotMatch(charge.name, /1\.56|0\.00/);
  assert.ok(parsed.items.filter(item => item !== charge).every(item => item.is_tracked_for_restock));
  assert.equal(parsed.parserWarning, "");
});

test("a total-discount column cannot become the payable total", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 700, text: "Milk 1 NOS 0401 100.00" },
    { y: 660, text: "Rice 1 NOS 1006 127.43" },
    { y: 620, text: "- Delivery and other - - - 1.56 0.00 0.00 0.00 0 0.00" },
    { y: 600, text: "1 NOS 9968 1.56" },
    { y: 120, text: "Total Discount 13.00" }
  ]], "2026-07-16");

  assert.notEqual(parsed.defaults.amount, "13.00");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /delivery, fee, discount, or tax rows/i);
});

test("Blinkit and generic charge lines remain explicit and never restock", () => {
  const parsed = parseReceipt([[
    { y: 200, text: "Blink Commerce Pvt Ltd - Blinkit" },
    { y: 180, text: "Apples 100.00" },
    { y: 160, text: "Platform fee 13.00" },
    { y: 120, text: "Total Paid 113.00" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.label, "Blinkit");
  assert.equal(parsed.defaults.amount, "113.00");
  assert.deepEqual(parsed.items.map(item => item.name), ["Apples", "Platform fee"]);
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 113);
  assert.equal(parsed.items[1].is_tracked_for_restock, false);
});

test("unlabelled numeric fallback is explicitly low confidence", () => {
  const parsed = parseReceipt([[{ y: 100, text: "Corner Shop" }, { y: 80, text: "Rice 120.00" }]], "2026-07-16");
  assert.equal(parsed.defaults.amount, "120.00");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /could not confidently identify the final paid or payable total/i);
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
