const cleanDisplayName = value => String(value || "").replace(/^\s*\d{1,2}\.\s+/, "").replace(/\s+/g, " ").trim();

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
    .trim();
}

export function restockHistory(purchases) {
  const groups = new Map();
  for (const purchase of purchases) {
    for (const item of purchase.purchase_items || []) {
      if (item.is_personal || !item.is_tracked_for_restock || /\b(?:fee|charges?)\b/i.test(item.name)) continue;
      const key = canonicalRestockKey(item.name);
      if (!key) continue;
      const entries = groups.get(key) || [];
      entries.push({ ...item, display_name: cleanDisplayName(item.name), purchased_on: purchase.purchased_on });
      groups.set(key, entries);
    }
  }
  return groups;
}

export function qualifiesForRestockSuggestion(items) {
  return new Set(items.map(item => item.purchased_on)).size >= 2;
}
