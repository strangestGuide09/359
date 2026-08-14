import { cleanImportedItemName } from "./imported-item-name.js";
import { isRestockMerchandise } from "./restock.js";

const feeName = /\b(?:delivery|handling|platform|packing|service|convenience|other)\s+(?:fee|fees|charge|charges)\b/i;

export function normalizeReviewedItem(values = {}) {
  const personal = !!values.is_personal;
  const merchandise = isRestockMerchandise(values.name);
  const fee = values.item_kind === "fee" || feeName.test(String(values.name || ""));
  return { id: values.id || null, name: values.name || "", quantity: values.quantity ?? 1, unit: values.unit || "", unit_price: values.unit_price ?? null, line_total: values.line_total ?? null, is_personal: personal, is_tracked_for_restock: fee || personal || !merchandise ? false : values.is_tracked_for_restock ?? true, estimated_use_by: values.estimated_use_by || "", item_kind: fee ? "fee" : "product", include_in_total: fee ? values.include_in_total === true : true };
}

export function reviewedItemPayload(item, display_order, includeId = false) {
  const payload = { name: cleanImportedItemName(item.name), quantity: item.quantity === "" ? null : Number(item.quantity), unit: item.unit.trim() || null, unit_price: item.unit_price === "" || item.unit_price == null ? null : Number(item.unit_price), line_total: item.line_total === "" || item.line_total == null ? null : Number(item.line_total), is_personal: !!item.is_personal, is_tracked_for_restock: item.item_kind !== "fee" && !item.is_personal && isRestockMerchandise(item.name) && !!item.is_tracked_for_restock, estimated_use_by: item.estimated_use_by || null, display_order };
  if (includeId && item.id) payload.id = item.id;
  return payload;
}

export function reviewedItemsForSave(items, includeIds = false) {
  return items.filter(item => item.item_kind !== "fee" || item.include_in_total).map((item, index) => reviewedItemPayload(item, index, includeIds));
}

export function savedPurchaseItemsForReview(items = []) {
  return [...items].sort((left, right) => Number(left.display_order || 0) - Number(right.display_order || 0)).map(item => normalizeReviewedItem({ ...item, include_in_total: true }));
}
