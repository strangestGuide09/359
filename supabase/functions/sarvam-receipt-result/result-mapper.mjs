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
  const allowedKeys = new Set(["job_id","status","pipeline","usage","created_at","updated_at"]);
  if (Object.keys(payload).some(key => !allowedKeys.has(key))) throw new Error("invalid_provider_result");
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
  const allowed = new Set(["authentication_required","origin_not_allowed","processing_disabled","job_not_found","job_expired","completion_timeout","submission_retry_exhausted","provider_pending","provider_failed","provider_unavailable","invalid_provider_result","provider_access_denied","provider_job_unavailable","provider_request_rejected","provider_rate_limited","provider_timeout","provider_connection_failed"]);
  return allowed.has(error?.message) ? error.message : "provider_unavailable";
}
