const cleanDisplayName = value => String(value || "").replace(/^\s*\d{1,2}\.\s+/, "").replace(/\s+/g, " ").trim();
const brandPrefix = /^(?:akshayakalpa|anveshan|amul|mother dairy|tata sampann|tata|fortune|aashirvaad|everyday)\b\s*/;
const nonMerchandise = /\b(?:delivery|handling|platform|convenience|packing|service)\s*(?:fee|fees|charge|charges)?\b|\b(?:fee|fees|charges?|tax|gst|cgst|sgst|cess|subtotal|grand total|total payable|amount paid|discount|savings?)\b/i;

export function canonicalRestockKey(value) {
  return cleanDisplayName(value)
    .toLowerCase()
    .replace(/^\d{4,8}\s+(?=[a-z])/, "")
    .replace(/(?:\s+-?\d+(?:\.\d+)?){2,}\s*$/, "")
    .replace(/\b(instamart|blinkit)\b/g, " ")
    .replace(/\bmillilit(?:er|re)s?\b/g, "ml")
    .replace(/\blit(?:er|re)s?\b/g, "l")
    .replace(/\bkilograms?\b/g, "kg")
    .replace(/\bgrams?\b/g, "g")
    .replace(/\bpack\s+of\s+(\d+)\b/g, "$1 pack")
    .replace(/(\d)\s*(ml|kg|g|l|pack)\b/g, "$1$2")
    .replace(/\bpack\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(brandPrefix, "")
    .replace(/^fresh\s+(?=[a-z])/, "");
}

export function restockHistory(purchases) {
  const groups = new Map();
  for (const purchase of purchases) {
    if (purchase.category && purchase.category !== "Groceries") continue;
    for (const item of purchase.purchase_items || []) {
      if (item.is_personal || !item.is_tracked_for_restock || nonMerchandise.test(item.name)) continue;
      const key = canonicalRestockKey(item.name);
      if (!key) continue;
      const entries = groups.get(key) || [];
      entries.push({ ...item, display_name: cleanDisplayName(item.name), purchased_on: purchase.purchased_on });
      groups.set(key, entries);
    }
  }
  return groups;
}

export function restockEmptyState(groups) {
  const entries = [...groups.values()].flat();
  if (!entries.length) return "No tracked grocery items yet. Import a grocery receipt and keep Track for restock selected on merchandise.";
  const dates = new Set(entries.map(item => item.purchased_on));
  return `Tracking ${groups.size} grocery item type${groups.size === 1 ? "" : "s"} across ${dates.size} purchase date${dates.size === 1 ? "" : "s"}. A suggestion appears after the same normalized item is bought on a second date; none has repeated yet.`;
}

export function qualifiesForRestockSuggestion(items) {
  return new Set(items.map(item => item.purchased_on)).size >= 2;
}
