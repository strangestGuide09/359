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

test("separate seller invoice values are combined only when they reconcile with all imported items", () => {
  const parsed = parseReceipt([
    [
      { y: 800, text: "Greenmania Modern Retails Pvt Ltd" },
      { y: 700, text: "First seller item 1 NOS 0803 727.00" },
      { y: 120, text: "Invoice Value 727.00" }
    ],
    [
      { y: 800, text: "Second seller" },
      { y: 700, text: "Second seller item 1 NOS 0803 144.00" },
      { y: 120, text: "Invoice Value 144.00" }
    ]
  ], "2026-07-16");

  assert.equal(parsed.defaults.amount, "871.00");
  assert.equal(parsed.totalConfidence, "calculated");
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 871);
  assert.deepEqual(parsed.invoiceBreakdown.map(invoice => ({ page: invoice.page, amount: invoice.amount, itemTotal: invoice.itemTotal })), [
    { page: 1, amount: 727, itemTotal: 727 },
    { page: 2, amount: 144, itemTotal: 144 }
  ]);
  assert.equal(parsed.repeatedInvoiceHeaders, true);
  assert.match(parsed.parserNotice, /2 invoices: ₹727\.00 \+ ₹144\.00/);
});

test("multi-seller pages are checked independently before review", () => {
  const parsed = parseReceipt([
    [{ y: 800, text: "Tax Invoice" }, { y: 700, text: "Seller one product 1 NOS 0803 700.00" }, { y: 120, text: "Invoice Value 727.00" }],
    [{ y: 800, text: "Tax Invoice" }, { y: 700, text: "Seller two product 1 NOS 0803 144.00" }, { y: 120, text: "Invoice Value 144.00" }]
  ], "2026-08-13");

  assert.equal(parsed.invoiceBreakdown.length, 2);
  assert.equal(parsed.invoiceBreakdown[0].itemTotal, 700);
  assert.match(parsed.parserWarning, /invoice pages do not reconcile/i);
  assert.equal(parsed.totalConfidence, "low");
});

test("operational fees remain separate paid shared lines and never restock", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Blinkit Tax Invoice" },
    { y: 700, text: "Fresh oranges 100.00" },
    { y: 680, text: "Handling fee 10.00" },
    { y: 120, text: "Amount payable 110.00" }
  ]], "2026-08-13");

  assert.deepEqual(parsed.items.map(item => ({ name: item.name, kind: item.item_kind, included: item.include_in_total, tracked: item.is_tracked_for_restock })), [
    { name: "Fresh oranges", kind: "product", included: true, tracked: true },
    { name: "Handling fee", kind: "fee", included: true, tracked: false }
  ]);
  assert.equal(parsed.feeTotal, 10);
  assert.equal(parsed.defaults.amount, "110.00");
  assert.match(parsed.parserNotice, /included as shared receipt lines/);
});

test("local parsing strips HSN labels while preserving sizes and rejects HSN-only rows", () => {
  const parsed = parseReceipt([[
    { y: 700, text: "Blinkit" },
    { y: 650, text: "Tata Sampann Kala Chana 500 g (HSN-07133100) 80.00" },
    { y: 620, text: "(HSN-07133100) 10.00" },
    { y: 100, text: "Amount payable 80.00" }
  ]], "2026-08-11");
  assert.deepEqual(parsed.items.map(item => item.name), ["Tata Sampann Kala Chana 500 g"]);
  assert.equal(parsed.defaults.amount, "80.00");
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
  assert.equal(cleanInstamartItemName("and other Desi Tomato (Pack) revised GST rates made effective by Govt."), "Desi Tomato (Pack)");
  assert.equal(cleanInstamartItemName("and other Akshayakalpa Malai Paneer (Pack) and other"), "Akshayakalpa Malai Paneer (Pack)");
});

test("purchase date extraction is label-aware and never falls back to upload day", () => {
  assert.equal(receiptDate("Date of Invoice: 03-07-2026 Category B2C", "2026-08-20"), "2026-07-03");
  assert.equal(receiptDate("Invoice Date: 1 Jul 2026", "2026-08-20"), "2026-07-01");
  assert.equal(receiptDate("Purchase Date: July 5, 2026", "2026-08-20"), "2026-07-05");
  assert.equal(receiptDate("revised GST rates effective 22 Sep 2025", "2026-08-20"), "");
});

test("fee row cannot absorb a footer year as quantity", () => {
  const parsed = parseReceipt([[
    { page:1,x:10,y:800,width:20,text:"Sr No" }, { page:1,x:80,y:800,width:100,text:"Description of Goods" }, { page:1,x:300,y:800,width:30,text:"Qty" }, { page:1,x:480,y:800,width:50,text:"Total" },
    { page:1,x:10,y:750,width:10,text:"1" }, { page:1,x:80,y:750,width:80,text:"Handling fee" }, { page:1,x:300,y:750,width:30,text:"2025" }, { page:1,x:480,y:750,width:40,text:"11.99" },
    { page:1,x:10,y:100,width:80,text:"Invoice Date:" }, { page:1,x:100,y:100,width:80,text:"06-07-2026" }
  ]]);
  assert.equal(parsed.items[0].name, "Handling fee");
  assert.equal(parsed.items[0].quantity, 1);
  assert.equal(parsed.items[0].is_tracked_for_restock, false);
});

test("payable total uses the amount beside its semantic label, not a later number", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 780, text: "Invoice Date: 16-07-2026" },
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
  assert.match(parsed.parserWarning, /purchase date/);
});

test("receipt-level discounts never rewrite parsed product line totals", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 700, text: "Milk 1 NOS 0401 400.00" },
    { y: 680, text: "Rice 1 NOS 1006 471.00" },
    { y: 140, text: "Subtotal 871.00 Discount 133.98" },
    { y: 120, text: "Final Amount Payable ₹737.02 Reference 144" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.amount, "737.02");
  assert.deepEqual(parsed.items.filter(item => item.item_kind === "product").map(item => item.line_total), [400, 471]);
  assert.deepEqual(parsed.items.find(item => item.item_kind === "discount"), {
    name: "Order discount", quantity: 1, unit: "", unit_price: null,
    line_total: -133.98, shared_line_total: -133.98, is_personal: false, is_tracked_for_restock: false,
    estimated_use_by: "", item_kind: "discount", include_in_total: true
  });
  assert.match(parsed.parserNotice, /separate signed reviewed line; product prices were not changed/);
  assert.match(parsed.parserWarning, /purchase date/);
});

test("separately additive tax and rounding are explicit signed components only when they exactly reconcile", () => {
  const tax = parseReceipt([["Corner shop", "Rice 100.00", "GST 18.00", "Amount payable 118.00"]], "");
  assert.equal(tax.items.find(item => item.item_kind === "product").line_total, 100);
  assert.deepEqual(tax.items.find(item => item.item_kind === "tax"), {
    name: "Separately additive tax", quantity: 1, unit: "", unit_price: 18,
    line_total: 18, shared_line_total: 18, is_personal: false, is_tracked_for_restock: false,
    estimated_use_by: "", item_kind: "tax", include_in_total: true
  });
  assert.equal(tax.components.tax, 18);
  assert.equal(tax.components.final, 118);

  const unexplained = parseReceipt([["Corner shop", "Rice 100.00", "Amount payable 118.00"]], "");
  assert.equal(unexplained.items.some(item => ["discount", "credit", "rounding", "tax"].includes(item.item_kind)), false);
  assert.match(unexplained.parserWarning, /do not reconcile/i);
});

test("multi-invoice products retain Boondi and tea invoice values without redistribution", () => {
  const parsed = parseReceipt([
    [
      { y: 800, text: "Tax Invoice Seller One" },
      { y: 700, text: "1. Boondi, Made in 1 NOS 2106 75.00" },
      { y: 680, text: "Other seller one groceries 1 NOS 2106 652.00" },
      { y: 120, text: "Invoice Value 727.00" }
    ],
    [
      { y: 800, text: "Tax Invoice Seller Two" },
      { y: 700, text: "2. Calm Chamomile Tea 1 NOS 0902 69.00" },
      { y: 680, text: "Other seller two groceries 1 NOS 0902 75.00" },
      { y: 120, text: "Invoice Value 144.00" }
    ]
  ], "2026-08-13");
  const boondi = parsed.items.find(item => /Boondi/.test(item.name));
  const tea = parsed.items.find(item => /Chamomile Tea/.test(item.name));
  assert.equal(boondi.line_total, 75);
  assert.equal(tea.line_total, 69);
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 871);
  assert.equal(parsed.defaults.amount, "871.00");
  assert.doesNotMatch(parsed.parserNotice, /allocated across item totals/i);
});

test("Instamart operational charges remain explicit untracked lines and summary rows are filtered", () => {
  const parsed = parseReceipt([[
    { y: 800, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 780, text: "Invoice Date: 16-07-2026" },
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
  assert.match(parsed.parserWarning, /enter it from the receipt/i);
});

test("Blinkit and generic charge lines remain explicit and never restock", () => {
  const parsed = parseReceipt([[
    { y: 200, text: "Blink Commerce Pvt Ltd - Blinkit" },
    { y: 180, text: "Apples 100.00" },
    { y: 160, text: "Platform fee 13.00" },
    { y: 150, text: "Platform fee 13.00" },
    { y: 120, text: "Total Paid 113.00" }
  ]], "2026-07-16");

  assert.equal(parsed.defaults.label, "Blinkit");
  assert.equal(parsed.defaults.amount, "113.00");
  assert.deepEqual(parsed.items.map(item => item.name), ["Apples", "Platform fee"]);
  assert.equal(parsed.items.reduce((sum, item) => sum + item.line_total, 0), 113);
  assert.equal(parsed.items[1].is_tracked_for_restock, false);
});

test("unlabelled numeric fallback remains unresolved instead of inventing a total", () => {
  const parsed = parseReceipt([[{ y: 100, text: "Corner Shop" }, { y: 80, text: "Rice 120.00" }]], "2026-07-16");
  assert.equal(parsed.defaults.amount, "");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /could not confidently identify a final paid or payable total/i);
});

test("polluted Instamart table rows do not create a false 4760 total or footer item", () => {
  const parsed = parseReceipt([[
    { y: 900, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 820, text: "8906 Anveshan Desi 1045.00 313.00 1 697.14 0.00 0.00 0.00" },
    { y: 800, text: "1 NOS 1515 697.14 17.43 17.43 0.00 732.00" },
    { y: 760, text: "Toor Dal 1 kg 350.00 0.00 1 350.00 0.00 0.00" },
    { y: 740, text: "1 NOS 0713 350.00" },
    { y: 700, text: "- Delivery and other - - - 1.56 0.00 0.00 0.00 0 0.00" },
    { y: 680, text: "1 NOS 9968 1.56 0.00 0.00 0.00" },
    { y: 660, text: "Delivery and other charges 1.56 0.00 0.00" },
    { y: 640, text: "1 NOS 9968 1.56 0.00 0.00 0.00" },
    { y: 160, text: "Total 14 3.54 3.54 998.00 4760.00" },
    { y: 140, text: "1 NOS 0000 998.00" }
  ]], "2026-07-22");

  assert.equal(parsed.defaults.amount, "");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /enter it from the receipt/i);
  assert.deepEqual(parsed.items.map(item => item.name), ["Anveshan Desi", "Toor Dal 1 kg", "Delivery and other charges"]);
  assert.deepEqual(parsed.items.map(item => item.line_total), [732, 350, 1.56]);
  assert.equal(parsed.items.filter(item => item.name === "Delivery and other charges").length, 1);
  assert.equal(parsed.items.at(-1).is_tracked_for_restock, false);
  assert.ok(parsed.items.slice(0, 2).every(item => item.is_tracked_for_restock));
  assert.ok(parsed.items.every(item => !/^total\b/i.test(item.name)));
  assert.ok(parsed.items.every(item => !/\d+\.\d+\s+\d+\.\d+/.test(item.name)));
});

test("an explicit payable total that does not reconcile is left unresolved", () => {
  const parsed = parseReceipt([[
    { y: 500, text: "Ekta Dhan Greenmania Modern Retails Pvt Ltd -" },
    { y: 400, text: "Rice 1 NOS 1006 100.00" },
    { y: 100, text: "Grand Total items 14 tax 3.54 ₹4,760.00" }
  ]], "2026-07-22");

  assert.equal(parsed.defaults.amount, "");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /enter it from the receipt|do not reconcile/i);
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

const positioned = (text, x, y, width = 40, page = 1) => ({ text, x, y, width, height: 10, page });

test("positioned invoice columns retain multiline descriptions and calculate a complete total", () => {
  const page = [
    positioned("Ekta Dhan Greenmania Modern Retails Pvt Ltd -", 40, 950, 260),
    positioned("Sr. no", 10, 900), positioned("UPC", 55, 900), positioned("Item Description", 140, 900, 130),
    positioned("Qty", 430, 900), positioned("MRP", 500, 900), positioned("Total Amount (Rs.)", 600, 900, 110)
  ];
  const ordinaryTotals = Array(19).fill(100).concat(135.04);
  let ordinaryIndex = 0;
  for (let serial = 1; serial <= 23; serial += 1) {
    const y = 860 - (serial - 1) * 30;
    const special = serial === 10 ? 100 : serial === 20 ? 80 : serial === 23 ? 145 : null;
    const total = special ?? ordinaryTotals[ordinaryIndex++];
    page.push(positioned(String(serial), 10, y, 12), positioned(`890600000${String(serial).padStart(2, "0")}`, 55, y, 72));
    if (serial === 10) page.push(positioned("Everyday", 140, y, 65), positioned("Apple (Pack)", 140, y - 9, 90));
    else if (serial === 20) page.push(positioned("Akshayakalpa Organic Artisanal", 140, y, 190), positioned("Organic Set Cup Curd (Cup)", 140, y - 9, 180));
    else if (serial === 23) page.push(positioned("Akshayakalpa Organic", 140, y, 145), positioned("Malai Paneer (Pack)", 140, y - 9, 145));
    else page.push(positioned(`Product ${serial} (Pack)`, 140, y, 110));
    page.push(positioned("1", 430, y, 8), positioned("9988", 485, y, 32), positioned("5.00", 535, y, 30), positioned(total.toFixed(2), 600, y, 48));
  }
  page.push(positioned("Total", 140, 140), positioned("14", 430, 140), positioned("3.54", 535, 140), positioned("3.54", 600, 140));
  const parsed = parseReceipt([page], "2026-07-22");

  assert.equal(parsed.defaults.amount, "2360.04");
  assert.equal(parsed.totalConfidence, "calculated");
  assert.match(parsed.parserNotice, /calculated from complete product and fee rows using the labelled Total column/i);
  assert.equal(parsed.items.length, 23);
  assert.deepEqual(parsed.items.filter(item => item.name.startsWith("Akshayakalpa")).map(item => [item.name, item.line_total]), [
    ["Akshayakalpa Organic Artisanal Organic Set Cup Curd (Cup)", 80],
    ["Akshayakalpa Organic Malai Paneer (Pack)", 145]
  ]);
  assert.equal(parsed.items.find(item => item.name.startsWith("Everyday")).name, "Everyday Apple (Pack)");
  assert.ok(parsed.items.every(item => item.quantity === 1));
  assert.ok(parsed.items.every(item => item.is_tracked_for_restock));
  assert.ok(parsed.items.every(item => !/890600|9988/.test(item.name)));
});

test("alternate positioned Description of Goods schema uses its rightmost Total column", () => {
  const page = [
    positioned("Corner invoice", 20, 600), positioned("Sr. no", 10, 550), positioned("Description of Goods", 100, 550, 150),
    positioned("Qty. and UQC", 330, 550), positioned("Taxable Value", 410, 550), positioned("Total", 560, 550),
    positioned("1", 10, 510), positioned("Everyday", 100, 510), positioned("Apple (Pack)", 100, 500), positioned("2", 330, 510), positioned("80.00", 410, 510), positioned("100.00", 560, 510),
    positioned("2", 10, 460), positioned("Organic Milk 1 L", 100, 460), positioned("1", 330, 460), positioned("50.00", 410, 460), positioned("65.00", 560, 460),
    positioned("Total", 100, 400), positioned("2", 330, 400), positioned("7.50", 410, 400), positioned("7.50", 560, 400)
  ];
  const parsed = parseReceipt([page], "2026-07-22");
  assert.equal(parsed.defaults.amount, "165.00");
  assert.deepEqual(parsed.items.map(item => [item.name, item.quantity, item.line_total]), [["Everyday Apple (Pack)", 2, 100], ["Organic Milk 1 L", 1, 65]]);
});

test("an incomplete positioned serial sequence cannot synthesize a receipt total", () => {
  const page = [
    positioned("Invoice", 20, 600), positioned("Sr. no", 10, 550), positioned("Item Description", 100, 550), positioned("Qty", 330, 550), positioned("Total", 560, 550),
    positioned("1", 10, 510), positioned("Rice 2 kg", 100, 510), positioned("1", 330, 510), positioned("120.00", 560, 510),
    positioned("2", 10, 460), positioned("Milk 1 L", 100, 460), positioned("1", 330, 460)
  ];
  const parsed = parseReceipt([page], "2026-07-22");
  assert.equal(parsed.defaults.amount, "");
  assert.equal(parsed.totalConfidence, "low");
  assert.match(parsed.parserWarning, /enter it from the receipt/i);
});

test("receipt dates remain unresolved when absent", () => {
  assert.equal(receiptDate("no date", "2026-07-16"), "");
});
