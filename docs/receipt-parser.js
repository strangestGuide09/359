const amountPattern = /(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;

const cleanText = value => String(value ?? "").replace(/\s+/g, " ").trim();
export function cleanInstamartItemName(value) {
  return cleanText(value)
    .replace(/^\d{1,2}\.\s+(?=[A-Za-z])/i, "")
    .replace(/^\d{4,8}\s+(?=[A-Za-z])/i, "")
    .replace(/(?:\s+-?\d+(?:,\d{3})*(?:\.\d+)?){2,}\s*$/, "")
    .replace(/\s*\(\s*([^()]*)\s*\)\s*/g, (_, inside) => ` (${inside.trim()}) `)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
const numberFrom = value => {
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const reviewedItem = values => ({
  name: values.name || "",
  quantity: values.quantity ?? 1,
  unit: values.unit || "",
  unit_price: values.unit_price ?? null,
  line_total: values.line_total ?? null,
  is_personal: false,
  is_tracked_for_restock: values.is_tracked_for_restock ?? true,
  estimated_use_by: ""
});

export function receiptDate(text, fallback = new Date().toISOString().slice(0, 10)) {
  const match = String(text).match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!match) return fallback;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const candidate = `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${candidate}T12:00:00`)) ? fallback : candidate;
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
  const preferred = [
    /\b(?:final amount payable|total payable|amount payable|amount paid|total paid|you paid|grand total|invoice value|net amount)\b/i
  ];
  for (const label of preferred) {
    for (const line of [...lines].reverse()) {
      const amount = semanticAmount(line, label, itemTotal);
      if (amount != null) return { amount, confidence: "high", source: line };
    }
  }
  for (const line of [...lines].reverse()) {
    if (!/^\s*total\b/i.test(line) || /^\s*total\s+(?:discount|tax|gst|cgst|sgst|cess|savings?|items?)\b/i.test(line)) continue;
    const amount = semanticAmount(line, /^\s*total\b/i, itemTotal);
    if (amount == null) continue;
    if (!itemTotal || amount >= itemTotal * .35) return { amount, confidence: "high", source: line };
  }
  const amounts = allAmounts(lines);
  const plausible = itemTotal ? amounts
    .map(amount => ({ amount, distance: Math.abs(amount - itemTotal) }))
    .filter(candidate => candidate.distance <= Math.max(1, itemTotal * .1))
    .sort((a, b) => a.distance - b.distance)[0]?.amount : amounts.length === 1 ? amounts[0] : null;
  return plausible != null ? { amount: plausible, confidence: "low", source: "numeric fallback" } : { amount: null, confidence: "low", source: "missing or implausible" };
}

function reconcileReceiptDiscount(items, total) {
  const itemTotal = items.reduce((sum, item) => sum + (Number(item.line_total) || 0), 0);
  if (!items.length || total == null || itemTotal <= total + .005 || total <= 0) return { items, notice: "" };
  const discount = itemTotal - total;
  if (discount / itemTotal > .5) return { items, notice: "" };
  let allocated = 0;
  const adjusted = items.map((item, index) => {
    const lineTotal = index === items.length - 1 ? Number((total - allocated).toFixed(2)) : Number((Number(item.line_total || 0) * total / itemTotal).toFixed(2));
    allocated += lineTotal;
    return { ...item, line_total: lineTotal, unit_price: item.quantity ? Number((lineTotal / item.quantity).toFixed(2)) : item.unit_price };
  });
  return { items: adjusted, notice: `Receipt-wide discount of ₹${discount.toFixed(2)} was allocated across item totals. Review before saving.` };
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
    const name = rowKind === "charge" ? chargeName(line) : match[1].replace(/^\d+(?:\.\d+)?\s*[x×]?\s*/i, "").trim();
    const positiveAmounts = allAmounts([line]).filter(amount => amount > 0);
    const amount = rowKind === "charge" ? positiveAmounts.at(-1) : numberFrom(match[2]);
    if (name && amount != null) items.push(reviewedItem({ name, line_total: amount, is_tracked_for_restock: rowKind !== "charge" }));
  }
  return items;
}

function instamartRowKind(text) {
  const normalized = cleanText(text).toLowerCase();
  if (/\b(?:discount|coupon|promo|tax|gst|cgst|sgst|cess|subtotal|grand total|total paid|total payable|amount paid|amount payable|invoice value|net amount|round[ -]?off|savings?)\b/.test(normalized)) return "summary";
  if (/\b(?:delivery(?:\s+and\s+other)?(?:\s+(?:fee|fees|charge|charges))?|(?:handling|platform|convenience|packing|service)\s+(?:fee|fees|charge|charges)|other\s+(?:fee|fees|charge|charges))\b/.test(normalized)) return "charge";
  return "product";
}

function chargeName(text) {
  if (/delivery/i.test(text)) return "Delivery and other charges";
  if (/handling/i.test(text)) return "Handling fee";
  if (/platform/i.test(text)) return "Platform fee";
  if (/packing/i.test(text)) return "Packing fee";
  return "Other receipt charges";
}

function instamartItems(pages) {
  const ignored = [
    "description of goods", "taxable", "discount", "amount", "value", "cgst", "sgst",
    "cess", "hsn", "invoice", "quantity", "grand total", "total payable", "greenmania",
    "modern retails", "private limited", "pvt ltd", "customer", "delivery address", "order id"
  ];
  const results = [];
  for (const page of pages) {
    const lines = page
      .map(line => ({ y: Number(line.y) || 0, text: cleanText(line.text) }))
      .filter(line => line.text);
    const prices = lines.flatMap(line => {
      const match = line.text.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+NOS\b.*?([0-9][0-9,]*(?:\.\d{1,2})?)\s*$/i);
      const amount = match ? numberFrom(match[2]) : null;
      const inlineName = match ? cleanText(line.text.slice(0, match.index)) : "";
      return match && amount != null ? [{ y: line.y, quantity: numberFrom(match[1]) || 1, amount, inlineName }] : [];
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
      const rawName = price.inlineName && /[a-z]/i.test(price.inlineName) ? price.inlineName : nearbyName;
      if (!rawName) return;
      const rowKind = instamartRowKind(rawName);
      if (rowKind === "summary") return;
      const name = rowKind === "charge" ? chargeName(rawName) : cleanInstamartItemName(rawName);
      results.push(reviewedItem({
        name,
        quantity: price.quantity,
        line_total: price.amount,
        unit_price: price.quantity ? Number((price.amount / price.quantity).toFixed(2)) : null,
        is_tracked_for_restock: rowKind !== "charge"
      }));
    });
  }
  return results;
}

export function parseReceipt(pages, fallbackDate) {
  const normalizedPages = pages.map(page => page
    .map(line => typeof line === "string" ? { y: 0, text: cleanText(line) } : { y: Number(line.y) || 0, text: cleanText(line.text) })
    .filter(line => line.text));
  const lines = normalizedPages.flatMap(page => page.map(line => line.text));
  const merchant = merchantFrom(lines);
  const parsedItems = merchant === "Instamart" ? instamartItems(normalizedPages) : genericItems(lines);
  const itemTotal = parsedItems.reduce((sum, item) => sum + (Number(item.line_total) || 0), 0);
  const total = receiptTotal(lines, itemTotal);
  const reconciled = total.confidence === "high" ? reconcileReceiptDiscount(parsedItems, total.amount) : { items: parsedItems, notice: "" };
  return {
    defaults: {
      label: merchant,
      amount: total.amount == null ? "" : total.amount.toFixed(2),
      date: receiptDate(lines.join(" "), fallbackDate),
      category: merchant === "Imported invoice" ? "Other" : "Groceries"
    },
    items: reconciled.items,
    parserWarning: total.confidence === "low" ? "We could not confidently identify the final paid or payable total. Check the receipt total and any delivery, fee, discount, or tax rows before saving." : "",
    parserNotice: reconciled.notice,
    totalConfidence: total.confidence
  };
}
