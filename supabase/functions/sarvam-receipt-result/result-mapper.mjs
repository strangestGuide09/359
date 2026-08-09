export const MAX_RESULT_ITEMS = 100;
const MAX_MONEY = 10_000_000;
const MAX_QUANTITY = 100_000;

const cleanStatus = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const boundedText = (value, max, { optional = false } = {}) => {
  if (value == null && optional) return "";
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid_provider_result");
  const text = value.replace(/\s+/g, " ").trim();
  if ((!text && !optional) || text.length > max) throw new Error("invalid_provider_result");
  return text;
};
const boundedNumber = (value, max) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const exactDate = value => {
  const text = boundedText(value, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("invalid_provider_result");
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error("invalid_provider_result");
  return text;
};

// A rejected provider result must not make its extracted receipt content
// observable in logs. Diagnostics expose only bounded property names, never
// provider values. That is enough to identify an envelope-contract mismatch
// without recording receipt text or extracted values.
const valueKind = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const fieldPresence = (record, fields) => Object.fromEntries(fields.map(field => [field, Boolean(record && Object.hasOwn(record, field))]));
const unknownFieldCount = (record, allowed) => record && typeof record === "object" && !Array.isArray(record)
  ? Object.keys(record).filter(field => !allowed.includes(field)).length
  : null;
const unknownFieldNames = (record, allowed) => record && typeof record === "object" && !Array.isArray(record)
  ? Object.keys(record)
    .filter(field => !allowed.includes(field))
    .filter(field => /^[a-z][a-z0-9_]{0,63}$/.test(field))
    .slice(0, 5)
  : null;
const safeResultStatus = value => {
  const state = cleanStatus(value, 40).toLowerCase();
  return ["completed", "partially_completed", "partiallycompleted"].includes(state) ? state : "other";
};
const safeProviderStatus = value => {
  const state = cleanStatus(value, 40).toLowerCase();
  if (["accepted", "pending", "queued", "running", "inprogress", "in_progress", "started"].includes(state)) return "pending";
  if (["completed", "partiallycompleted", "partially_completed"].includes(state)) return "completed";
  if (["failed", "rejected", "cancelled", "canceled"].includes(state)) return "failed";
  return "other";
};

// Status responses arrive before receipt data. This stays structural so it can
// explain an upstream contract mismatch without recording document content.
export function providerStatusShapeDiagnostic(payload, expectedJobId) {
  const payloadFields = ["job_id","run_id","status","pipeline","usage","created_at","updated_at"];
  const usageFields = ["pages_total","pages_processed","pages_succeeded","pages_failed"];
  const usage = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.usage : null;
  return {
    payload_kind: valueKind(payload),
    payload_expected_job_matches: Boolean(payload && payload.job_id === expectedJobId),
    payload_unknown_field_count: unknownFieldCount(payload, payloadFields),
    payload_unknown_fields: unknownFieldNames(payload, payloadFields),
    pipeline_is_extract: Boolean(payload && cleanStatus(payload.pipeline, 20).toLowerCase() === "extract"),
    provider_status: safeProviderStatus(payload?.status),
    usage_kind: valueKind(usage),
    usage_fields: fieldPresence(usage, usageFields),
    usage_unknown_field_count: unknownFieldCount(usage, usageFields)
  };
}

export function resultShapeDiagnostic(payload, expectedJobId) {
  const payloadFields = ["job_id","type","status","usage","result","annotations","version"];
  const receiptFields = ["merchant_name","purchase_date","receipt_total","currency","line_items"];
  const itemFields = ["name","quantity","unit","line_total"];
  const receipt = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.result : null;
  const items = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt.line_items : null;
  const firstItem = Array.isArray(items) ? items[0] : null;
  const numericItems = Array.isArray(items) && items.every(item => item && typeof item === "object" && typeof item.line_total === "number" && Number.isFinite(item.line_total));
  const receiptTotal = receipt && typeof receipt === "object" ? receipt.receipt_total : null;
  return {
    payload_kind: valueKind(payload),
    payload_expected_job_matches: Boolean(payload && payload.job_id === expectedJobId),
    payload_type_is_extract: Boolean(payload && payload.type === "extract"),
    payload_status: safeResultStatus(payload?.status),
    payload_unknown_field_count: unknownFieldCount(payload, payloadFields),
    result_kind: valueKind(receipt),
    result_fields: fieldPresence(receipt, receiptFields),
    result_unknown_field_count: unknownFieldCount(receipt, receiptFields),
    line_items_kind: valueKind(items),
    line_item_count: Array.isArray(items) && items.length <= MAX_RESULT_ITEMS ? items.length : null,
    first_line_item_kind: valueKind(firstItem),
    first_line_item_fields: fieldPresence(firstItem, itemFields),
    first_line_item_unknown_field_count: unknownFieldCount(firstItem, itemFields),
    receipt_total_kind: valueKind(receiptTotal),
    currency_is_inr: Boolean(receipt && receipt.currency === "INR"),
    amounts_reconcile: Boolean(numericItems && typeof receiptTotal === "number" && Number.isFinite(receiptTotal) && Math.abs(receiptTotal - items.reduce((sum, item) => sum + item.line_total, 0)) <= .01)
  };
}

export function validateProviderUsage(payload, maxPages, { allowZero = false } = {}) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object" || !Number.isInteger(maxPages) || maxPages < 1) throw new Error("invalid_provider_result");
  const fields = ["pages_total","pages_processed","pages_succeeded","pages_failed"];
  if (Object.keys(usage).some(key => !fields.includes(key))) throw new Error("invalid_provider_result");
  if (fields.some(key => !Number.isInteger(usage[key]) || usage[key] < 0 || usage[key] > maxPages)) throw new Error("invalid_provider_result");
  if ((!allowZero && usage.pages_processed < 1) || usage.pages_processed > usage.pages_total || usage.pages_succeeded + usage.pages_failed > usage.pages_processed) throw new Error("invalid_provider_result");
  return usage;
}

export function providerState(payload, expectedJobId, maxPages) {
  if (!payload || typeof payload !== "object" || cleanStatus(payload.job_id, 160) !== expectedJobId) throw new Error("invalid_provider_result");
  // Extract runs asynchronously. Sarvam documents the opaque run_id on its
  // Extract job contract; accept only its bounded identifier, not arbitrary
  // provider fields, so the status boundary remains fail-closed.
  const allowedKeys = new Set(["job_id","run_id","status","pipeline","usage","created_at","updated_at"]);
  if (Object.keys(payload).some(key => !allowedKeys.has(key))) throw new Error("invalid_provider_result");
  if (payload.run_id != null && (typeof payload.run_id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(payload.run_id))) throw new Error("invalid_provider_result");
  if (cleanStatus(payload.pipeline, 20).toLowerCase() !== "extract") throw new Error("invalid_provider_result");
  validateProviderUsage(payload, maxPages, { allowZero: true });
  const state = cleanStatus(payload.status, 40).toLowerCase();
  if (["accepted","pending","queued","running","inprogress","in_progress","started"].includes(state)) return "pending";
  if (["completed","partiallycompleted","partially_completed"].includes(state)) return "completed";
  if (["failed","rejected","cancelled","canceled"].includes(state)) return "failed";
  throw new Error("invalid_provider_result");
}

export function mapProviderReceipt(payload, expectedJobId, maxPages) {
  if (!payload || typeof payload !== "object" || cleanStatus(payload.job_id, 160) !== expectedJobId || payload.type !== "extract" || !["completed","partially_completed"].includes(cleanStatus(payload.status, 40).toLowerCase())) throw new Error("invalid_provider_result");
  const allowedPayloadKeys = new Set(["job_id","type","status","usage","result","annotations","version"]);
  if (Object.keys(payload).some(key => !allowedPayloadKeys.has(key))) throw new Error("invalid_provider_result");
  validateProviderUsage(payload, maxPages);
  const receipt = payload.result;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("invalid_provider_result");
  const allowedReceiptKeys = new Set(["merchant_name","purchase_date","receipt_total","currency","line_items"]);
  if (Object.keys(receipt).some(key => !allowedReceiptKeys.has(key)) || boundedText(receipt.currency, 3) !== "INR") throw new Error("invalid_provider_result");
  if (!Array.isArray(receipt.line_items) || !receipt.line_items.length || receipt.line_items.length > MAX_RESULT_ITEMS) throw new Error("invalid_provider_result");
  const items = receipt.line_items.map((item, display_order) => {
    if (!item || typeof item !== "object") throw new Error("invalid_provider_result");
    const allowedItemKeys = new Set(["name","quantity","unit","line_total"]);
    if (Object.keys(item).some(key => !allowedItemKeys.has(key))) throw new Error("invalid_provider_result");
    const name = boundedText(item.name, 160);
    const quantity = boundedNumber(item.quantity, MAX_QUANTITY);
    const unit = boundedText(item.unit, 30, { optional: true }) || null;
    const line_total = boundedNumber(item.line_total, MAX_MONEY);
    if (line_total == null || quantity == null || quantity <= 0) throw new Error("invalid_provider_result");
    return { name, quantity, unit, unit_price: null, line_total, is_personal: false, is_tracked_for_restock: true, estimated_use_by: null, display_order };
  });
  const amount = boundedNumber(receipt.receipt_total, MAX_MONEY);
  const itemTotal = items.reduce((sum, item) => sum + item.line_total, 0);
  if (amount == null || amount <= 0 || Math.abs(amount - itemTotal) > .01) throw new Error("invalid_provider_result");
  const label = boundedText(receipt.merchant_name, 160);
  return { defaults: { label, category: "Groceries", amount: amount.toFixed(2), date: exactDate(receipt.purchase_date) }, items };
}

export function fixedCompletionError(error) {
  const allowed = new Set(["authentication_required","origin_not_allowed","processing_disabled","job_not_found","job_expired","completion_timeout","submission_retry_exhausted","provider_pending","provider_failed","provider_unavailable","invalid_provider_result","provider_access_denied","provider_job_unavailable","provider_request_rejected","provider_rate_limited","provider_timeout","provider_connection_failed","provider_service_unavailable"]);
  return allowed.has(error?.message) ? error.message : "provider_unavailable";
}
