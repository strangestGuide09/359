const cents = value => Math.round((Number(value) || 0) * 100);

export function receiptSettlementAllocations({ purchases, existingAllocations, receiver, amount, settledOn }) {
  let remaining = cents(amount);
  if (remaining <= 0) return [];
  const allocatedByPurchase = new Map();
  for (const allocation of existingAllocations || []) {
    allocatedByPurchase.set(allocation.purchase_id, (allocatedByPurchase.get(allocation.purchase_id) || 0) + cents(allocation.amount));
  }
  const candidates = (purchases || [])
    .filter(purchase => purchase.paid_by === receiver && purchase.purchased_on <= settledOn && cents(purchase.shared_amount) > 0)
    .sort((a, b) => a.purchased_on.localeCompare(b.purchased_on) || a.id.localeCompare(b.id));
  const result = [];
  for (const purchase of candidates) {
    const capacity = Math.max(0, Math.round(cents(purchase.shared_amount) / 2) - (allocatedByPurchase.get(purchase.id) || 0));
    const applied = Math.min(remaining, capacity);
    if (applied > 0) result.push({ purchase_id: purchase.id, purchase_item_id: null, amount: applied / 100 });
    remaining -= applied;
    if (!remaining) break;
  }
  return remaining ? [] : result;
}
