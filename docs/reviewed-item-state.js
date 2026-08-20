import { cleanImportedItemName } from "./imported-item-name.js";
import { isRestockMerchandise } from "./restock.js";

const kinds = new Set(["product", "fee", "tax", "discount", "credit", "rounding", "informational"]);
const feeName = /\b(?:delivery|handling|platform|packing|packaging|service|convenience|small[ -]?cart|surge|rain|late[ -]?night|gift|tip|other)\s+(?:fee|fees|charge|charges)?\b/i;
const kindFromName = name => /\brefund|credit applied\b/i.test(name) ? "credit"
  : /\bdiscount|coupon|promo|savings\b/i.test(name) ? "discount"
  : /\bround/i.test(name) ? "rounding"
  : /\btax|gst|cess\b/i.test(name) ? "tax"
  : feeName.test(name) ? "fee" : "product";
const positiveKind = kind => ["product", "fee", "tax"].includes(kind);

export function normalizeReviewedItem(values = {}) {
  const name = String(values.name || "");
  const legacyKind = values.item_kind === "adjustment" ? kindFromName(name) : values.item_kind;
  const itemKind = kinds.has(legacyKind) ? legacyKind : kindFromName(name);
  const includeInTotal = itemKind === "informational" ? false : values.include_in_total !== false;
  const personal = !!values.is_personal;
  const lineTotal = values.line_total ?? null;
  const sharedLineTotal = includeInTotal ? values.shared_line_total ?? (personal ? 0 : lineTotal) : 0;
  const merchandise = itemKind === "product" && includeInTotal && isRestockMerchandise(name);
  return {
    id: values.id || null, name, quantity: values.quantity ?? 1, unit: values.unit || "",
    unit_price: positiveKind(itemKind) ? values.unit_price ?? null : null,
    line_total: lineTotal, shared_line_total: sharedLineTotal, is_personal: personal,
    is_tracked_for_restock: merchandise && !personal ? values.is_tracked_for_restock ?? true : false,
    estimated_use_by: values.estimated_use_by || "", item_kind: itemKind, include_in_total: includeInTotal
  };
}

export function reviewedItemPayload(item, display_order, includeId = false) {
  const normalized = normalizeReviewedItem(item);
  const payload = {
    name: cleanImportedItemName(normalized.name), quantity: normalized.quantity === "" ? null : Number(normalized.quantity),
    unit: normalized.unit.trim() || null,
    unit_price: normalized.unit_price === "" || normalized.unit_price == null ? null : Number(normalized.unit_price),
    line_total: normalized.line_total === "" || normalized.line_total == null ? null : Number(normalized.line_total),
    shared_line_total: normalized.shared_line_total === "" || normalized.shared_line_total == null ? null : Number(normalized.shared_line_total),
    is_personal: normalized.is_personal,
    is_tracked_for_restock: normalized.item_kind === "product" && normalized.include_in_total && !normalized.is_personal && isRestockMerchandise(normalized.name) && !!normalized.is_tracked_for_restock,
    estimated_use_by: normalized.estimated_use_by || null, item_kind: normalized.item_kind,
    include_in_total: normalized.include_in_total, display_order
  };
  if (includeId && normalized.id) payload.id = normalized.id;
  return payload;
}

export function reviewedItemsForSave(items, includeIds = false) {
  return items.map((item, index) => reviewedItemPayload(item, index, includeIds));
}

export function savedPurchaseItemsForReview(items = []) {
  return [...items].sort((left, right) => Number(left.display_order || 0) - Number(right.display_order || 0)).map(normalizeReviewedItem);
}
