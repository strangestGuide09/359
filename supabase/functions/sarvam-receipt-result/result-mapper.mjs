export const MAX_RESULT_ITEMS = 100;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const finite = value => { const number = Number(value); return Number.isFinite(number) ? number : null; };
const date = value => { const text = clean(value, 10); return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T12:00:00Z`)) ? text : ""; };

export function providerState(payload, expectedJobId) {
  if (!payload || typeof payload !== "object" || clean(payload.job_id, 160) !== expectedJobId) throw new Error("invalid_provider_result");
  if (payload.pipeline && clean(payload.pipeline, 20).toLowerCase() !== "extract") throw new Error("invalid_provider_result");
  const state = clean(payload.status, 40).toLowerCase();
  if (["accepted","pending","queued","running","inprogress","in_progress","started"].includes(state)) return "pending";
  if (["completed","partiallycompleted","partially_completed"].includes(state)) return "completed";
  if (["failed","rejected","cancelled","canceled"].includes(state)) return "failed";
  throw new Error("invalid_provider_result");
}

export function mapProviderReceipt(payload, expectedJobId) {
  if (!payload || typeof payload !== "object" || clean(payload.job_id, 160) !== expectedJobId || payload.type !== "extract" || !["completed","partially_completed"].includes(clean(payload.status, 40).toLowerCase())) throw new Error("invalid_provider_result");
  const receipt = payload.result;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("invalid_provider_result");
  const allowedReceiptKeys = new Set(["merchant_name","purchase_date","receipt_total","currency","line_items"]);
  if (Object.keys(receipt).some(key => !allowedReceiptKeys.has(key)) || clean(receipt.currency, 3) !== "INR") throw new Error("invalid_provider_result");
  if (!Array.isArray(receipt.line_items) || !receipt.line_items.length || receipt.line_items.length > MAX_RESULT_ITEMS) throw new Error("invalid_provider_result");
  const items = receipt.line_items.map((item, display_order) => {
    if (!item || typeof item !== "object") throw new Error("invalid_provider_result");
    const allowedItemKeys = new Set(["name","quantity","unit","line_total"]);
    if (Object.keys(item).some(key => !allowedItemKeys.has(key))) throw new Error("invalid_provider_result");
    const name = clean(item.name, 160);
    const quantity = finite(item.quantity);
    const unit = clean(item.unit, 30) || null;
    const line_total = finite(item.line_total);
    if (!name || line_total == null || line_total < 0 || quantity == null || quantity <= 0) throw new Error("invalid_provider_result");
    return { name, quantity, unit, unit_price: null, line_total, is_personal: false, is_tracked_for_restock: true, estimated_use_by: null, display_order };
  });
  const amount = finite(receipt.receipt_total);
  const itemTotal = items.reduce((sum, item) => sum + item.line_total, 0);
  if (amount == null || amount <= 0 || Math.abs(amount - itemTotal) > .01) throw new Error("invalid_provider_result");
  const label = clean(receipt.merchant_name, 160);
  if (!label) throw new Error("invalid_provider_result");
  return { defaults: { label, category: "Groceries", amount: amount.toFixed(2), date: date(receipt.purchase_date) }, items };
}

export function fixedCompletionError(error) {
  const allowed = new Set(["authentication_required","origin_not_allowed","processing_disabled","job_not_found","job_expired","completion_timeout","provider_pending","provider_failed","provider_unavailable","invalid_provider_result"]);
  return allowed.has(error?.message) ? error.message : "provider_unavailable";
}
