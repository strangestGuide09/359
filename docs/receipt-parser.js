const amountPattern = /(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;

const cleanText = value => String(value ?? "").replace(/\s+/g, " ").trim();
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
  is_tracked_for_restock: false,
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

function lastAmount(line) {
  const matches = [...line.matchAll(amountPattern)];
  return matches.length ? numberFrom(matches.at(-1)[1]) : null;
}

function receiptTotal(lines) {
  const preferred = [
    /\b(?:invoice value|grand total|total payable|amount payable|net amount)\b/i,
    /^\s*total\b/i
  ];
  for (const label of preferred) {
    for (const line of [...lines].reverse()) {
      if (!label.test(line)) continue;
      const amount = lastAmount(line);
      if (amount != null) return amount;
    }
  }
  const amounts = allAmounts(lines);
  return amounts.length ? Math.max(...amounts) : null;
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
    if (/\b(total|subtotal|tax|gst|discount|change|cash|card|upi|amount|invoice value)\b/i.test(line)) continue;
    const match = line.match(/^(.{2,120}?)\s+(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.\d{1,2})\s*$/i);
    if (!match || !/[a-z]/i.test(match[1])) continue;
    const name = match[1].replace(/^\d+(?:\.\d+)?\s*[x×]?\s*/i, "").trim();
    const amount = numberFrom(match[2]);
    if (name && amount != null) items.push(reviewedItem({ name, line_total: amount }));
  }
  return items;
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
      const name = price.inlineName && /[a-z]/i.test(price.inlineName) ? price.inlineName : nearbyName;
      results.push(reviewedItem({
        name: name || `Invoice item ${results.length + 1}`,
        quantity: price.quantity,
        line_total: price.amount,
        unit_price: price.quantity ? Number((price.amount / price.quantity).toFixed(2)) : null
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
  const items = merchant === "Instamart" ? instamartItems(normalizedPages) : genericItems(lines);
  const total = receiptTotal(lines);
  return {
    defaults: {
      label: merchant,
      amount: total == null ? "" : total.toFixed(2),
      date: receiptDate(lines.join(" "), fallbackDate),
      category: merchant === "Imported invoice" ? "Other" : "Groceries"
    },
    items
  };
}
