import { cleanImportedItemName } from "./imported-item-name.js";

const amountPattern = /(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;

const cleanText = value => String(value ?? "").replace(/\s+/g, " ").trim();
export function cleanInstamartItemName(value) {
  return cleanImportedItemName(cleanText(value)
    .replace(/^(?:and\s+other(?:\s+|$))+/i, "")
    .replace(/^\d{1,2}\.\s+(?=[A-Za-z])/i, "")
    .replace(/^\d{4,8}\s+(?=[A-Za-z])/i, "")
    .replace(/(?:\s+-?\d+(?:,\d{3})*(?:\.\d+)?){2,}\s*$/, "")
    .replace(/\s+(?:and\s+other\s+(?:charges?|fees?)|revised\s+gst\s+rates?|made\s+effective\s+by|delivery\s+confirmation|terms\s+and\s+conditions|wherever\s+applicable)\b[\s\S]*$/i, "")
    .replace(/\s+(?:[A-Z][a-z-]+\s+){0,8}(?:Rupees?|Private\s+Limited|formerly\s+known|FSSAI|PAN)\b[\s\S]*$/i, "")
    .replace(/\s*\(?\s*HSN\s*[-:]?\s*\)?\s*$/i, "")
    .replace(/\s+and\s+other\s*$/i, "")
    .replace(/\s*\(\s*([^()]*)\s*\)\s*/g, (_, inside) => ` (${inside.trim()}) `)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim());
}
const numberFrom = value => {
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const reviewedItem = values => ({
  name: cleanImportedItemName(values.name),
  quantity: values.quantity ?? 1,
  unit: values.unit || "",
  unit_price: values.unit_price ?? null,
  line_total: values.line_total ?? null,
  shared_line_total: values.shared_line_total ?? values.line_total ?? null,
  is_personal: !!values.is_personal,
  is_tracked_for_restock: values.is_tracked_for_restock ?? true,
  estimated_use_by: "",
  item_kind: values.item_kind || "product",
  include_in_total: values.item_kind === "informational" ? false : values.include_in_total !== false
});

const months = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };
function validDate(year, month, day) {
  const candidate = `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  const date = new Date(`${candidate}T12:00:00Z`);
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day) ? candidate : "";
}
export function receiptDate(text) {
  const source = String(text);
  const label = /\b(?:date\s+of\s+invoice|invoice\s+date|purchase\s+date|receipt\s+date|order\s+date|invoice)\s*(?::|#|-)?\s*/gi;
  for (const match of source.matchAll(label)) {
    const value = source.slice(match.index + match[0].length, match.index + match[0].length + 80).trimStart();
    let date = value.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
    if (date) {
      const year = date[3].length === 2 ? Number(`20${date[3]}`) : Number(date[3]);
      const parsed = validDate(year, Number(date[2]), Number(date[1]));
      if (parsed) return parsed;
    }
    date = value.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})\b/i);
    if (date && months[date[2].toLowerCase()]) {
      const year = date[3].length === 2 ? Number(`20${date[3]}`) : Number(date[3]);
      const parsed = validDate(year, months[date[2].toLowerCase()], Number(date[1]));
      if (parsed) return parsed;
    }
    date = value.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{2,4})\b/i);
    if (date && months[date[1].toLowerCase()]) {
      const year = date[3].length === 2 ? Number(`20${date[3]}`) : Number(date[3]);
      const parsed = validDate(year, months[date[1].toLowerCase()], Number(date[2]));
      if (parsed) return parsed;
    }
  }
  // PDF text layers occasionally place a labelled date and its value on two
  // adjacent baselines. Accept a lone unambiguous calendar date only when a
  // supported receipt-date label is present somewhere in the extracted text.
  if (/\b(?:date\s+of\s+invoice|invoice\s+date|purchase\s+date|receipt\s+date|order\s+date)\b/i.test(source)) {
    const candidates = new Set();
    for (const match of source.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g)) {
      const parsed = validDate(Number(match[3]), Number(match[2]), Number(match[1]));
      if (parsed) candidates.add(parsed);
    }
    if (candidates.size === 1) return [...candidates][0];
  }
  return "";
}

function allAmounts(lines) {
  return lines.flatMap(line => [...line.matchAll(amountPattern)]
    .map(match => numberFrom(match[1]))
    .filter(value => value != null));
}

function amountsAfter(line, label) {
  const match = line.match(label);
  if (!match) return [];
  const tail = line.slice((match.index || 0) + match[0].length);
  return [...tail.matchAll(amountPattern)].map(amount => numberFrom(amount[1])).filter(amount => amount != null);
}

function semanticAmount(line, label, itemTotal) {
  const candidates = amountsAfter(line, label);
  if (!candidates.length) return null;
  const selected = itemTotal ? [...candidates].sort((a, b) => Math.abs(a - itemTotal) - Math.abs(b - itemTotal))[0] : candidates.at(-1);
  return itemTotal && selected < itemTotal * .35 ? null : selected;
}

function receiptTotal(lines, itemTotal) {
  // Some marketplace orders contain separate tax invoices from more than one
  // seller. Each invoice has its own explicitly labelled Invoice Value, while
  // the imported item table contains every seller's items. Prefer their sum
  // only when it exactly reconciles with those item rows; repeated page
  // footers and unrelated summary figures therefore remain ineligible.
  const invoiceValues = lines
    .map(line => amountsAfter(line, /\binvoice\s+value\b/i).at(0))
    .filter(amount => amount != null && amount > 0);
  if (invoiceValues.length > 1) {
    const combined = Number(invoiceValues.reduce((sum, amount) => sum + amount, 0).toFixed(2));
    if (itemTotal > 0 && Math.abs(combined - itemTotal) <= .01) {
      return { amount: combined, confidence: "calculated", source: "combined labelled invoice values" };
    }
  }
  const preferred = [
    /\b(?:final amount payable|total payable|amount payable|amount paid|total paid|you paid|grand total|invoice value|net amount)\b/i
  ];
  for (const label of preferred) {
    for (const line of [...lines].reverse()) {
      const amount = semanticAmount(line, label, itemTotal);
      if (amount != null) return { amount, confidence: "high", source: line };
    }
  }
  // A bare "Total" is common in HSN/tax summaries and may be followed by an
  // item count, tax rate, or column total. Never promote it to the payable
  // amount, and never invent a receipt total from an unlabelled number.
  return { amount: null, confidence: "low", source: "missing explicit payable total" };
}

function reconcileReceiptDiscount(items, total, lines) {
  const itemTotal = items.filter(item => item.include_in_total !== false).reduce((sum, item) => sum + (Number(item.line_total) || 0), 0);
  if (!items.length || total == null || Math.abs(itemTotal - total) <= .005 || total <= 0) return { items, notice: "" };
  const difference = Number((total - itemTotal).toFixed(2));
  const roles = difference < 0
    ? [{ pattern: /\b(?:order|cart|coupon|promo)?\s*(?:discount|coupon|promo|savings?)\b/i, name: "Order discount", kind: "discount" }]
    : [
        { pattern: /\bround(?:ing|ed)?[ -]?(?:off|adjustment)?\b/i, name: "Rounding adjustment", kind: "rounding" },
        { pattern: /\b(?:tax|gst|cgst|sgst|cess)\b/i, name: "Separately additive tax", kind: "tax" }
      ];
  const role = roles.find(candidate => lines.some(line => candidate.pattern.test(line)
    && amountsAfter(line, candidate.pattern).some(amount => Math.abs(amount - Math.abs(difference)) <= .01)));
  if (!role || Math.abs(difference) / itemTotal > .5) return { items, notice: "", mismatch: true };
  const adjustment = reviewedItem({ name: role.name, quantity: 1, unit_price: role.kind === "tax" ? difference : null, line_total: difference, shared_line_total: difference, item_kind: role.kind, is_personal: false, is_tracked_for_restock: false });
  return { items: [...items, adjustment], notice: `${role.name} of ${difference < 0 ? "−" : "+"}₹${Math.abs(difference).toFixed(2)} was kept as a separate signed reviewed line; product prices were not changed.` };
}

function merchantFrom(lines) {
  const text = lines.join("\n");
  if (/greenmania|instamaxx|swiggy\s+instamart/i.test(text)) return "Instamart";
  if (/blink commerce|zomato hyperpure|blinkit/i.test(text)) return "Blinkit";
  const restaurant = text.match(/restaurant\s+name\s*:\s*([^\n]+)/i)?.[1];
  if (restaurant) return cleanText(restaurant).slice(0, 160);
  return (lines.find(line => /[a-z]{3}/i.test(line)
    && !/invoice|receipt|tax|gst|customer|buyer|ship(?:ped)?\s+to|bill(?:ed)?\s+to|order\s+(?:id|number)|date/i.test(line))
    || "Receipt import — review merchant").slice(0, 160);
}

function genericItems(lines) {
  const items = [];
  for (const line of lines) {
    const rowKind = instamartRowKind(line);
    if (rowKind === "summary" || /\b(change|cash|card|upi)\b/i.test(line)) continue;
    const match = line.match(/^(.{2,120}?)\s+(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.\d{1,2})\s*$/i);
    if (!match || !/[a-z]/i.test(match[1])) continue;
    const name = rowKind === "charge" ? chargeName(line) : cleanInstamartItemName(match[1].replace(/^\d+(?:\.\d+)?\s*[x×]?\s*/i, ""));
    const positiveAmounts = allAmounts([line]).filter(amount => amount > 0);
    const amount = rowKind === "charge" ? positiveAmounts.at(-1) : numberFrom(match[2]);
    if (!name || amount == null) continue;
    const item = reviewedItem({ name, line_total: amount, is_tracked_for_restock: rowKind !== "charge", item_kind: rowKind === "charge" ? "fee" : "product" });
    if (rowKind === "charge") {
      const existing = items.find(result => result.name === name && !result.is_tracked_for_restock);
      if (existing) {
        if (item.line_total > existing.line_total) Object.assign(existing, item);
        continue;
      }
    }
    items.push(item);
  }
  return items;
}

function instamartRowKind(text) {
  const normalized = cleanText(text).toLowerCase();
  if (/^total\b/.test(normalized) || /\b(?:discount|coupon|promo|tax|gst|cgst|sgst|cess|subtotal|grand total|total paid|total payable|amount paid|amount payable|invoice value|net amount|round[ -]?off|savings?|payment summary)\b/.test(normalized)) return "summary";
  if (/\b(?:delivery(?:\s+and\s+other)?(?:\s+(?:fee|fees|charge|charges))?|(?:handling|platform|convenience|packing|service)\s+(?:fee|fees|charge|charges)|other\s+(?:fee|fees|charge|charges))\b/.test(normalized)) return "charge";
  return "product";
}

const boilerplateDescription = /\b(?:revised gst rates?|made effective by|terms and conditions|delivery confirmation|invoice to|customer|address|order id|amount in words|principal supply|wherever applicable)\b/i;

function chargeName(text) {
  if (/delivery/i.test(text)) return "Delivery and other charges";
  if (/handling/i.test(text)) return "Handling fee";
  if (/platform/i.test(text)) return "Platform fee";
  if (/packing/i.test(text)) return "Packing fee";
  return "Other receipt charges";
}

const tokenAmount = token => {
  const values = allAmounts([cleanText(token?.text)]);
  return values.length ? values.at(-1) : null;
};

function tableSchema(tokens) {
  const descriptions = tokens.filter(token => /\b(?:item\s+description|description(?:\s+of\s+goods)?)\b/i.test(token.text));
  for (const description of descriptions) {
    // Marketplace invoice headers commonly wrap over two baselines (for
    // example, "Total" above "Amount"). Keep the band wide enough to join
    // those header cells, but still far narrower than the first item row.
    const band = tokens.filter(token => Math.abs(token.y - description.y) <= 30);
    const serial = band.filter(token => /^(?:sr\.?\s*(?:no\.?)?|s\.?\s*no\.?)$/i.test(cleanText(token.text))).sort((a, b) => a.x - b.x)[0];
    const quantity = band.filter(token => /^(?:qty\.?|quantity)\b(?:\s*(?:\/|and)?\s*uqc)?/i.test(cleanText(token.text))).sort((a, b) => a.x - b.x)[0];
    const mrp = band.filter(token => /^mrp$/i.test(cleanText(token.text))).sort((a, b) => a.x - b.x)[0];
    const totals = band.filter(token => /^total(?:\s+amount)?(?:\s*\(\s*rs\.?\s*\))?\.?$/i.test(cleanText(token.text))).sort((a, b) => b.x - a.x);
    const total = totals[0];
    if (serial && quantity && total && serial.x < description.x && description.x < quantity.x && quantity.x < total.x) {
      const itemHeader = band.filter(token => /^item$/i.test(cleanText(token.text)) && token.x > serial.x && token.x < description.x).sort((a, b) => a.x - b.x)[0];
      return { headerY: description.y, serialX: serial.x, descriptionX: itemHeader?.x ?? description.x, descriptionRight: Math.min(mrp?.x ?? quantity.x, quantity.x), quantityX: quantity.x, totalX: total.x, totalRight: total.x + total.width, rowStartsAtSerial: !!itemHeader };
    }
  }
  return null;
}

function positionedInvoiceTable(pages) {
  const rows = [];
  let sawSchema = false;
  let detectedSerialCount = 0;
  for (const page of pages) {
    const tokens = page.filter(token => Number.isFinite(token.x) && Number.isFinite(token.y) && token.text);
    const schema = tableSchema(tokens);
    if (!schema) continue;
    sawSchema = true;
    const footerY = tokens
      .filter(token => token.y < schema.headerY - 2 && token.x <= schema.serialX + 25 && /^total$/i.test(cleanText(token.text)))
      .sort((a, b) => b.y - a.y)[0]?.y;
    const serials = tokens
      .filter(token => token.y < schema.headerY - 2 && (footerY == null || token.y > footerY) && Math.abs(token.x - schema.serialX) <= 18 && /^\d{1,3}\.?$/.test(cleanText(token.text)))
      .map(token => ({ ...token, serial: Number.parseInt(token.text, 10) }))
      .sort((a, b) => b.y - a.y);
    const typicalGap = serials.length > 1 ? Math.max(22, Math.min(70, serials.slice(0, -1).reduce((sum, token, index) => sum + (token.y - serials[index + 1].y), 0) / (serials.length - 1))) : 44;
    detectedSerialCount += serials.length;
    serials.forEach((serial, index) => {
      const previous = serials[index - 1];
      const next = serials[index + 1];
      const upper = schema.rowStartsAtSerial ? serial.y + 3 : previous ? (previous.y + serial.y) / 2 : schema.headerY - 2;
      const lower = next ? (serial.y + next.y) / 2 : Math.max(serial.y - typicalGap * .8, footerY == null ? -Infinity : footerY + 3);
      const rowTokens = tokens.filter(token => token.y <= upper && token.y > lower);
      const chargeYs = rowTokens.filter(token => /^(?:delivery|handling|platform)$/i.test(cleanText(token.text))).map(token => token.y);
      const description = rowTokens
        .filter(token => token.x >= schema.descriptionX - 8 && token.x < schema.descriptionRight - 4 && cleanText(token.text))
        .filter(token => !chargeYs.some(y => Math.abs(token.y - y) <= 10))
        .filter(token => !boilerplateDescription.test(token.text))
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map(token => token.text)
        .join(" ");
      const quantityToken = rowTokens
        .filter(token => Math.abs(token.x - schema.quantityX) <= 35 && tokenAmount(token) != null)
        .sort((a, b) => Math.abs(a.y - serial.y) - Math.abs(b.y - serial.y) || Math.abs(a.x - schema.quantityX) - Math.abs(b.x - schema.quantityX))[0];
      const totalToken = rowTokens
        .filter(token => token.x >= schema.totalX - 45 && tokenAmount(token) != null)
        .sort((a, b) => Math.abs(a.y - serial.y) - Math.abs(b.y - serial.y) || Math.abs((a.x + a.width) - schema.totalRight) - Math.abs((b.x + b.width) - schema.totalRight))[0];
      const name = cleanInstamartItemName(description);
      const rawQuantity = quantityToken ? tokenAmount(quantityToken) : null;
      const lineTotal = totalToken ? tokenAmount(totalToken) : null;
      const kind = instamartRowKind(name);
      if (kind === "summary") return;
      const quantity = kind === "charge" ? 1 : rawQuantity;
      if (!name || quantity == null || quantity <= 0 || quantity >= 1900 || lineTotal == null || lineTotal < 0) return;
      rows.push({ serial: serial.serial, page: serial.page || 0, kind, item: reviewedItem({
        name: kind === "charge" ? chargeName(name) : name,
        quantity,
        line_total: lineTotal,
        unit_price: quantity ? Number((lineTotal / quantity).toFixed(2)) : null,
        is_tracked_for_restock: kind !== "charge",
        item_kind: kind === "charge" ? "fee" : "product"
      }) });
    });
  }
  if (!sawSchema || !rows.length) return null;
  rows.sort((a, b) => a.page - b.page || a.serial - b.serial);
  const serials = rows.map(row => row.serial);
  const pageRows = new Map();
  rows.forEach(row => pageRows.set(row.page, [...(pageRows.get(row.page) || []), row]));
  const contiguous = [...pageRows.values()].every(group => group.every((row, index) => row.serial === index + 1));
  const items = [];
  rows.forEach(({ kind, item }) => {
    if (kind === "charge") {
      const existing = items.find(candidate => candidate.name === item.name && !candidate.is_tracked_for_restock);
      if (existing) { if (item.line_total > existing.line_total) Object.assign(existing, item); return; }
    }
    items.push(item);
  });
  return { items, complete: contiguous && rows.length === detectedSerialCount && rows.length >= 2, serials };
}

function positionedTableTotals(pages) {
  const totals = [];
  for (const page of pages) {
    const schema = tableSchema(page);
    if (!schema) continue;
    const candidates = page.filter(token => token.y < schema.headerY && token.x <= schema.serialX + 25 && /^total$/i.test(cleanText(token.text)));
    for (const label of candidates) {
      const amounts = page
        .filter(token => Math.abs(token.y - label.y) <= 8 && token.x > label.x + label.width && tokenAmount(token) != null)
        .map(tokenAmount)
        .filter(amount => amount > 0);
      if (amounts.length) totals.push(Math.max(...amounts));
    }
  }
  return totals;
}

function positionedFees(pages) {
  const delivery = [];
  const handling = [];
  for (const page of pages) {
    const schema = tableSchema(page);
    if (schema) {
      for (const token of page.filter(token => /^delivery$/i.test(cleanText(token.text)) && token.x >= schema.descriptionX - 8 && token.x < schema.quantityX)) {
        const amount = page
          .filter(candidate => Math.abs(candidate.y - token.y) <= 3 && candidate.x >= schema.totalX - 45 && tokenAmount(candidate) != null)
          .sort((a, b) => Math.abs((a.x + a.width) - schema.totalRight) - Math.abs((b.x + b.width) - schema.totalRight))[0];
        if (amount && tokenAmount(amount) > 0) delivery.push(tokenAmount(amount));
      }
    }
    for (const token of page.filter(token => /handling\s+fee/i.test(cleanText(token.text)))) {
      const totalHeader = page
        .filter(candidate => Math.abs(candidate.y - token.y) <= 30 && /^total$/i.test(cleanText(candidate.text)) && candidate.x > token.x)
        .sort((a, b) => b.x - a.x)[0];
      if (!totalHeader) continue;
      const amounts = page
        .filter(candidate => candidate.y < totalHeader.y && totalHeader.y - candidate.y <= 80 && Math.abs(candidate.x - totalHeader.x) <= 15 && tokenAmount(candidate) != null)
        .map(tokenAmount)
        .filter(amount => amount > 0);
      if (amounts.length) handling.push(Number(amounts.reduce((sum, amount) => sum + amount, 0).toFixed(2)));
    }
  }
  const deliveryTotal = Number(delivery.reduce((sum, amount) => sum + amount, 0).toFixed(2));
  const handlingTotal = Number(handling.reduce((sum, amount) => sum + amount, 0).toFixed(2));
  const amount = deliveryTotal && handlingTotal && Math.abs(deliveryTotal - handlingTotal) <= .02
    ? deliveryTotal
    : Number((deliveryTotal + handlingTotal).toFixed(2));
  return amount > 0 ? [reviewedItem({ name: deliveryTotal ? "Delivery and other charges" : "Handling fee", quantity: 1, line_total: amount, unit_price: amount, item_kind: "fee", is_personal: false, is_tracked_for_restock: false, include_in_total: true })] : [];
}

function linesForPage(page) {
  if (!page.some(record => Number.isFinite(record.x))) return page.map(record => ({ y: Number(record.y) || 0, text: cleanText(record.text) })).filter(record => record.text);
  const rows = new Map();
  page.forEach(token => {
    const y = Math.round((Number(token.y) || 0) / 2) * 2;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(token);
  });
  return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([y, tokens]) => ({ y, text: tokens.sort((a, b) => a.x - b.x).map(token => cleanText(token.text)).filter(Boolean).join(" ") }));
}

function instamartItems(pages) {
  const ignored = [
    "description of goods", "taxable", "discount", "amount", "value", "cgst", "sgst",
    "cess", "hsn", "invoice", "quantity", "grand total", "total payable", "greenmania",
    "modern retails", "private limited", "pvt ltd", "customer", "delivery address", "order id",
    "payment summary", "total items"
  ];
  const results = [];
  for (const page of pages) {
    const lines = page
      .map(line => ({ y: Number(line.y) || 0, text: cleanText(line.text) }))
      .filter(line => line.text);
    const prices = lines.flatMap(line => {
      const match = line.text.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+NOS\b(.*)$/i);
      const tailAmounts = match ? allAmounts([match[2]]) : [];
      const amount = tailAmounts.length ? tailAmounts.at(-1) : null;
      const inlineName = match ? cleanInstamartItemName(line.text.slice(0, match.index)) : "";
      return match && amount != null ? [{ y: line.y, quantity: numberFrom(match[1]) || 1, amount, tailAmounts, inlineName }] : [];
    }).sort((a, b) => b.y - a.y);

    prices.forEach((price, index) => {
      const previous = prices[index - 1];
      const next = prices[index + 1];
      const upper = previous ? (previous.y + price.y) / 2 : next ? price.y + (price.y - next.y) / 2 : price.y + 30;
      const lower = next ? (price.y + next.y) / 2 : previous ? price.y - (previous.y - price.y) / 2 : price.y - 30;
      const nearbyName = lines
        .filter(line => {
          const lowerText = line.text.toLowerCase();
          return line.y <= upper && line.y >= lower && /[a-z]/i.test(line.text)
            && !/\bNOS\b/i.test(line.text)
            && !ignored.some(value => lowerText.includes(value));
        })
        .sort((a, b) => b.y - a.y)
        .map(line => line.text)
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
      const rawName = price.inlineName && /[a-z]/i.test(price.inlineName) ? price.inlineName : cleanInstamartItemName(nearbyName);
      if (!rawName) return;
      const rowKind = instamartRowKind(rawName);
      if (rowKind === "summary") return;
      const name = rowKind === "charge" ? chargeName(rawName) : cleanInstamartItemName(rawName);
      // Charge rows in some invoices finish with zero-valued tax columns. In
      // that layout the last positive decimal after the HSN/service code is the
      // charge, while merchandise rows continue to use the final amount column.
      const chargeAmounts = price.tailAmounts.filter((amount, index) => amount > 0 && !(index === 0 && Number.isInteger(amount) && amount >= 1000));
      const lineTotal = rowKind === "charge" && price.amount === 0 ? chargeAmounts.at(-1) ?? 0 : price.amount;
      const item = reviewedItem({
        name,
        quantity: rowKind === "charge" ? 1 : price.quantity,
        line_total: lineTotal,
        unit_price: price.quantity ? Number((lineTotal / price.quantity).toFixed(2)) : null,
        is_tracked_for_restock: rowKind !== "charge",
        item_kind: rowKind === "charge" ? "fee" : "product"
      });
      if (rowKind === "charge") {
        const existing = results.find(result => result.name === name && !result.is_tracked_for_restock);
        if (existing) {
          if (item.line_total > existing.line_total) Object.assign(existing, item);
          return;
        }
      }
      results.push(item);
    });
  }
  return results;
}

function invoiceBreakdown(positionedPages, normalizedPages, merchant) {
  const pages = normalizedPages.map((page, index) => {
    const lines = page.map(line => line.text);
    const hasHeader = lines.some(line => /\b(?:tax\s+invoice|invoice\s+(?:no\.?|number|date)|invoice\s+value)\b/i.test(line));
    const structured = positionedInvoiceTable([positionedPages[index]]);
    const items = structured?.items?.length ? structured.items : merchant === "Instamart" ? instamartItems([page]) : genericItems(lines);
    const itemTotal = Number(items.reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2));
    const candidates = lines.flatMap(line => amountsAfter(line, /\binvoice\s+value\b/i)).filter(amount => amount > 0);
    const amount = candidates.length ? [...candidates].sort((a, b) => Math.abs(a - itemTotal) - Math.abs(b - itemTotal))[0] : null;
    return { page: index + 1, hasHeader, amount, itemTotal, itemCount: items.length };
  });
  const invoices = pages.filter(page => page.hasHeader && page.amount != null && page.itemCount > 0);
  return {
    invoices: invoices.length > 1 ? invoices : [],
    repeatedHeaders: pages.filter(page => page.hasHeader).length > 1,
    mismatch: invoices.some(invoice => Math.abs(invoice.amount - invoice.itemTotal) > .01)
  };
}

export function parseReceipt(pages, fallbackDate) {
  const positionedPages = pages.map((page, pageIndex) => page.map(record => typeof record === "string"
    ? { page: pageIndex + 1, y: 0, text: cleanText(record) }
    : { page: Number(record.page) || pageIndex + 1, x: record.x == null ? undefined : Number(record.x), y: Number(record.y) || 0, width: Number(record.width) || 0, height: Number(record.height) || 0, text: cleanText(record.text) }).filter(record => record.text));
  const normalizedPages = positionedPages.map(linesForPage);
  const lines = normalizedPages.flatMap(page => page.map(line => line.text));
  const merchant = merchantFrom(lines);
  const bundle = invoiceBreakdown(positionedPages, normalizedPages, merchant);
  const structured = positionedInvoiceTable(positionedPages);
  const baseItems = structured?.items?.length ? structured.items : merchant === "Instamart" ? instamartItems(normalizedPages) : genericItems(lines);
  const detectedPositionedFees = positionedFees(positionedPages);
  const parsedItems = [...baseItems.filter(item => item.item_kind !== "fee"), ...(detectedPositionedFees.length ? detectedPositionedFees : baseItems.filter(item => item.item_kind === "fee"))]
    .map(item => ({ ...item, name: cleanImportedItemName(item.name) }))
    .filter(item => item.name);
  const productTotal = Number(parsedItems.filter(item => item.item_kind !== "fee").reduce((sum, item) => sum + (Number(item.line_total) || 0), 0).toFixed(2));
  const tableTotals = positionedTableTotals(positionedPages);
  const tableTotal = tableTotals.length ? Number(tableTotals.reduce((sum, amount) => sum + amount, 0).toFixed(2)) : null;
  const fees = parsedItems.filter(item => item.item_kind === "fee");
  const detectedFeeTotal = Number(fees.reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2));
  // Some invoice tables round a tax-split fee by a paisa. The labelled Total
  // column is allowed to resolve only that fee line; product prices are never
  // redistributed or rewritten.
  const tableFeeDifference = tableTotal == null ? 0 : Number((tableTotal - productTotal).toFixed(2));
  if (fees.length === 1 && tableFeeDifference > 0 && Math.abs(detectedFeeTotal - tableFeeDifference) <= .05) {
    fees[0].line_total = tableFeeDifference;
    fees[0].unit_price = tableFeeDifference;
  }
  const feeTotalCandidate = Number(fees.reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2));
  const itemTotal = Number((productTotal + feeTotalCandidate).toFixed(2));
  const semanticTotal = receiptTotal(lines, itemTotal);
  let calculatedTotal = null;
  if (structured?.complete) {
    if (tableTotal == null) calculatedTotal = itemTotal;
    else if (Math.abs(tableTotal - productTotal) <= .01) calculatedTotal = itemTotal;
    else if (Math.abs(tableTotal - itemTotal) <= .01) calculatedTotal = tableTotal;
  }
  const total = calculatedTotal == null ? semanticTotal : { amount: calculatedTotal, confidence: "calculated", source: "structured product and fee totals" };
  const reconciled = total.confidence === "high" ? reconcileReceiptDiscount(parsedItems, total.amount, lines) : { items: parsedItems, notice: "", mismatch: false };
  const unresolvedTotal = !["high", "calculated"].includes(total.confidence);
  const unreconciled = !!reconciled.mismatch || (total.amount != null && Math.abs(reconciled.items.filter(item => item.include_in_total !== false).reduce((sum, item) => sum + (Number(item.line_total) || 0), 0) - total.amount) > .01);
  const parserWarning = bundle.mismatch && unreconciled
    ? "One or more invoice pages do not reconcile with the line items parsed from that page. Review each invoice breakdown before continuing."
    : unresolvedTotal
    ? "We could not confidently identify a final paid or payable total. Enter it from the receipt, then verify every item and charge before saving."
    : unreconciled
      ? "The extracted products and charges do not reconcile with the payable total. Check for a missing discount, fee, or incorrect line total before saving."
      : "";
  const feeTotal = Number(reconciled.items.filter(item => item.item_kind === "fee").reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2));
  const discountTotal = Number(reconciled.items.filter(item => ["discount", "credit"].includes(item.item_kind)).reduce((sum, item) => sum + Math.abs(Number(item.line_total || 0)), 0).toFixed(2));
  const taxTotal = Number(reconciled.items.filter(item => item.item_kind === "tax").reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2));
  const roundingTotal = Number(reconciled.items.filter(item => item.item_kind === "rounding").reduce((sum, item) => sum + Number(item.line_total || 0), 0).toFixed(2));
  const breakdownNotice = bundle.invoices.length ? `${bundle.invoices.length} invoices: ${bundle.invoices.map(invoice => `₹${invoice.amount.toFixed(2)}`).join(" + ")}. Repeated invoice headers were treated as separate invoices.` : "";
  const feeNotice = feeTotal > 0 ? `Paid fees of ₹${feeTotal.toFixed(2)} were included as shared receipt lines. Review their labels and amounts; fees never become Possible Buys.` : "";
  return {
    defaults: {
      label: merchant,
      amount: total.amount == null ? "" : total.amount.toFixed(2),
      date: receiptDate(lines.join(" ")),
      category: merchant === "Imported invoice" ? "Other" : "Groceries"
    },
    items: reconciled.items,
    invoiceBreakdown: bundle.invoices,
    repeatedInvoiceHeaders: bundle.repeatedHeaders,
    feeTotal,
    components: { products: productTotal, fees: feeTotal, discounts: discountTotal, tax: taxTotal, rounding: roundingTotal, final: total.amount },
    parserWarning: [!receiptDate(lines.join(" ")) ? "We could not confidently identify the purchase date. Choose the date printed on the receipt before saving; the upload date was not used." : "", parserWarning].filter(Boolean).join(" "),
    parserNotice: [breakdownNotice, feeNotice, calculatedTotal == null ? reconciled.notice : "Receipt total was calculated from complete product and fee rows using the labelled Total column. Verify it against the invoice before saving."].filter(Boolean).join(" "),
    totalConfidence: unreconciled ? "low" : total.confidence
  };
}
