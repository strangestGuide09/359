import { cleanImportedItemName } from "./imported-item-name.js";

const unidentified = value => /^Unidentified receipt line \d+$/i.test(String(value || "").trim());

export function reconcileAiItemNames(aiItems, localItems) {
  if (!Array.isArray(aiItems)) return aiItems;
  const cleanedAiItems = aiItems.map(item => ({ ...item, name: cleanImportedItemName(item?.name) }));
  if (!Array.isArray(localItems) || aiItems.length !== localItems.length) return cleanedAiItems;
  return cleanedAiItems.map((item, index) => {
    if (!unidentified(item?.name)) return item;
    const local = localItems[index];
    const sameLineTotal = Number.isFinite(Number(item?.line_total)) && Number.isFinite(Number(local?.line_total))
      && Math.abs(Number(item.line_total) - Number(local.line_total)) <= .01;
    const localName = cleanImportedItemName(local?.name);
    return sameLineTotal && localName && !unidentified(localName) ? { ...item, name: localName } : item;
  });
}

export function hasUnidentifiedAiItems(items) {
  return Array.isArray(items) && items.some(item => unidentified(item?.name));
}
