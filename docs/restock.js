const cleanDisplayName = value => String(value || "")
  .replace(/^\s*\d{1,2}\.\s+/, "")
  .replace(/^\d{4,8}\s+(?=[A-Za-z])/, "")
  .replace(/(?:\s+-?\d+(?:,\d{3})*(?:\.\d+)?){2,}\s*$/, "")
  .replace(/\s*\(\s*pack\s*\)\s*/gi, " ")
  .replace(/\s+/g, " ").trim();
const brandPrefix = /^(?:akshayakalpa|anveshan|amul|mother dairy|tata sampann|tata|fortune|aashirvaad|everyday)\b\s*/;
const nonMerchandise = /\b(?:delivery|shipping|handling|platform|convenience|packing|service)\s*(?:fee|fees|charge|charges)?\b|\b(?:fee|fees|charges?|tax|gst|cgst|sgst|cess|subtotal|total|amount payable|amount paid|discount|savings?)\b/i;
const localAlias = /\([^)]*\b(?:hasiru|menasinakaayi|nimbe|hannu|nellikaayi|dappa|soutekaayi|bendekaayi|baalehannu|hagalakaayi)\b[^)]*\)/gi;

export function isRestockMerchandise(value) {
  return !nonMerchandise.test(String(value || ""));
}

export function canonicalRestockKey(value) {
  return cleanDisplayName(value)
    .toLowerCase()
    .replace(localAlias, " ")
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
  return restockEligibility(purchases).groups;
}

export function restockEligibility(purchases) {
  const groups = new Map();
  const stats = { excludedCategory: 0, excludedFees: 0, excludedPersonal: 0, excludedUntracked: 0, qualifyingItems: 0, purchaseDates: new Set() };
  for (const purchase of purchases) {
    if (purchase.category && purchase.category !== "Groceries") { stats.excludedCategory += (purchase.purchase_items || []).length; continue; }
    for (const item of purchase.purchase_items || []) {
      if (item.is_personal) { stats.excludedPersonal += 1; continue; }
      if (!isRestockMerchandise(item.name)) { stats.excludedFees += 1; continue; }
      if (!item.is_tracked_for_restock) { stats.excludedUntracked += 1; continue; }
      const key = canonicalRestockKey(item.name);
      if (!key) continue;
      const entries = groups.get(key) || [];
      entries.push({ ...item, display_name: cleanDisplayName(item.name), purchased_on: purchase.purchased_on });
      groups.set(key, entries);
      stats.qualifyingItems += 1;
      stats.purchaseDates.add(purchase.purchased_on);
    }
  }
  return { groups, stats: { ...stats, purchaseDates: stats.purchaseDates.size, repeatTypes: [...groups.values()].filter(qualifiesForRestockSuggestion).length } };
}

export function restockEmptyGuidance(groups, stats = {}) {
  const entries = [...groups.values()].flat();
  const exclusions = [`${stats.excludedFees || 0} fee, tax, or delivery`, `${stats.excludedPersonal || 0} personal`, `${stats.excludedUntracked || 0} untracked`, `${stats.excludedCategory || 0} outside groceries`].join(" · ");
  if (!entries.length) return {
    title: "Track a grocery item to get started",
    next: "Import a grocery receipt and keep Track for restock selected on merchandise.",
    detail: `No eligible tracked grocery merchandise yet. Excluded: ${exclusions}.`
  };
  const dateCount = stats.purchaseDates ?? new Set(entries.map(item => item.purchased_on)).size;
  return {
    title: "Buy a tracked item again to unlock suggestions",
    next: `Tracking ${groups.size} grocery item type${groups.size === 1 ? "" : "s"} across ${dateCount} purchase date${dateCount === 1 ? "" : "s"}. Possible Buys needs the same item on 2 different dates.`,
    detail: `${stats.repeatTypes || 0} items repeat on a second date. Excluded: ${exclusions}. Names are normalized across common merchant and pack-label variations.`
  };
}

export function restockEmptyState(groups, stats = {}) {
  const guidance = restockEmptyGuidance(groups, stats);
  return `${guidance.title}. ${guidance.next} ${guidance.detail}`;
}

export function qualifiesForRestockSuggestion(items) {
  return new Set(items.map(item => item.purchased_on)).size >= 2;
}
