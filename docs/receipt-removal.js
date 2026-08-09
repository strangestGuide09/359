export const RECEIPT_UNDO_KEY = "grocery-ledger-receipt-undo-v1";

export function rememberRemovedReceipt(storage, householdId, userId, purchaseId) {
  storage.setItem(RECEIPT_UNDO_KEY, JSON.stringify({ householdId, userId, purchaseId }));
}

export function readRemovedReceipt(storage, householdId, userId, archivedPurchases) {
  let saved;
  try { saved = JSON.parse(storage.getItem(RECEIPT_UNDO_KEY) || "null"); } catch { saved = null; }
  if (!saved || saved.householdId !== householdId || saved.userId !== userId || typeof saved.purchaseId !== "string") return null;
  const purchase = archivedPurchases.find(item => item.id === saved.purchaseId);
  if (!purchase) { storage.removeItem(RECEIPT_UNDO_KEY); return null; }
  return purchase;
}

export function forgetRemovedReceipt(storage, purchaseId) {
  let saved;
  try { saved = JSON.parse(storage.getItem(RECEIPT_UNDO_KEY) || "null"); } catch { saved = null; }
  if (!purchaseId || saved?.purchaseId === purchaseId) storage.removeItem(RECEIPT_UNDO_KEY);
}
