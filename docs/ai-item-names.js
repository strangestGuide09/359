const unidentified = value => /^Unidentified receipt line \d+$/i.test(String(value || "").trim());

export function reconcileAiItemNames(aiItems, localItems) {
  if (!Array.isArray(aiItems) || !Array.isArray(localItems) || aiItems.length !== localItems.length) return aiItems;
  return aiItems.map((item, index) => {
    if (!unidentified(item?.name)) return item;
    const local = localItems[index];
    const sameLineTotal = Number.isFinite(Number(item?.line_total)) && Number.isFinite(Number(local?.line_total))
      && Math.abs(Number(item.line_total) - Number(local.line_total)) <= .01;
    const localName = String(local?.name || "").trim();
    return sameLineTotal && localName && !unidentified(localName) ? { ...item, name: localName } : item;
  });
}

export function hasUnidentifiedAiItems(items) {
  return Array.isArray(items) && items.some(item => unidentified(item?.name));
}
