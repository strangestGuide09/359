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
const optionalExactDate = value => {
  if (value == null || value === "") return "";
  return exactDate(value);
};
const isBoundedText = (value, max, options) => {
  try {
    boundedText(value, max, options);
    return true;
  } catch {
    return false;
  }
};
const isExactDate = value => {
  try {
    exactDate(value);
    return true;
  } catch {
    return false;
  }
};
const isOptionalExactDate = value => {
  try {
    optionalExactDate(value);
    return true;
  } catch {
    return false;
  }
};
const isPositiveBoundedNumber = (value, max) => {
  const number = boundedNumber(value, max);
  return number != null && number > 0;
};
const reviewedItemName = (value, displayOrder) => {
  // The extraction schema explicitly permits an empty name when the visible
  // row cannot be read. Preserve that row for manual review, but do not let a
  // malformed provider type, control character, or oversized value bypass the
  // strict result contract by turning it into the same placeholder.
  if (value == null || (typeof value === "string" && !value.trim())) return `Unidentified receipt line ${displayOrder + 1}`;
  return boundedText(value, 160);
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
    // Provider envelope keys may be snake_case or camelCase. Restrict this to
    // ordinary API identifiers; values and arbitrary/unprintable keys remain
    // unavailable to logs.
    .filter(field => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field))
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
const requiredProviderUsageFields = ["pages_total","pages_processed","pages_succeeded","pages_failed"];
const optionalProviderUsageFields = ["pages_discarded"];
const providerUsageFields = [...requiredProviderUsageFields, ...optionalProviderUsageFields];

// Status responses arrive before receipt data. This stays structural so it can
// explain an upstream contract mismatch without recording document content.
export function providerStatusShapeDiagnostic(payload, expectedJobId) {
  const payloadFields = ["job_id","run_id","status","pipeline","usage","created_at","updated_at"];
  const usageFields = providerUsageFields;
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

export function resultShapeDiagnostic(payload, expectedJobId, maxPages) {
  const payloadFields = ["job_id","type","status","usage","result","annotations","version"];
  const receiptFields = ["merchant_name","purchase_date","receipt_total","currency","line_items"];
  const itemFields = ["name","quantity","unit","line_total"];
  const usageFields = providerUsageFields;
  const receipt = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.result : null;
  const usage = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.usage : null;
  const items = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt.line_items : null;
  const firstItem = Array.isArray(items) ? items[0] : null;
  const numericItems = Array.isArray(items) && items.every(item => item && typeof item === "object" && typeof item.line_total === "number" && Number.isFinite(item.line_total));
  const receiptTotal = receipt && typeof receipt === "object" ? receipt.receipt_total : null;
  const receiptTotalMissing = receiptTotal == null || receiptTotal === "";
  const positiveItemTotals = numericItems && items.every(item => item.line_total > 0 && item.line_total <= MAX_MONEY);
  const itemRecords = Array.isArray(items) ? items : [];
  const itemsAreRecords = Array.isArray(items) && itemRecords.every(item => item && typeof item === "object" && !Array.isArray(item));
  const usageIsValid = (() => {
    try {
      validateProviderUsage(payload, maxPages);
      return true;
    } catch {
      return false;
    }
  })();
  const usageHasOnlyExpectedFields = Boolean(usage && typeof usage === "object" && !Array.isArray(usage)
    && Object.keys(usage).every(field => usageFields.includes(field)));
  const usageValuesAreNonnegativeIntegers = Boolean(usage && typeof usage === "object" && !Array.isArray(usage)
    && requiredProviderUsageFields.every(field => Number.isInteger(usage[field]) && usage[field] >= 0)
    && optionalProviderUsageFields.every(field => usage[field] === undefined || (Number.isInteger(usage[field]) && usage[field] >= 0)));
  const usageValuesFitReservation = Boolean(usageValuesAreNonnegativeIntegers && Number.isInteger(maxPages) && maxPages >= 1
    && providerUsageFields.every(field => usage[field] === undefined || usage[field] <= maxPages));
  const usageProcessedIsNonzero = Boolean(usageValuesAreNonnegativeIntegers && usage.pages_processed >= 1);
  const usageProcessedFitsTotal = Boolean(usageValuesAreNonnegativeIntegers && usage.pages_processed <= usage.pages_total);
  const usageOutcomesFitProcessed = Boolean(usageValuesAreNonnegativeIntegers
    && usage.pages_succeeded + usage.pages_failed <= usage.pages_processed);
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
    amounts_reconcile: Boolean(positiveItemTotals && (receiptTotalMissing
      || (typeof receiptTotal === "number" && Number.isFinite(receiptTotal) && Math.abs(receiptTotal - items.reduce((sum, item) => sum + item.line_total, 0)) <= .01))),
    provider_usage_is_valid: usageIsValid,
    provider_usage_kind: valueKind(usage),
    provider_usage_fields: fieldPresence(usage, usageFields),
    provider_usage_required_fields_present: Boolean(usage && requiredProviderUsageFields.every(field => Object.prototype.hasOwnProperty.call(usage, field))),
    provider_usage_unknown_field_count: unknownFieldCount(usage, usageFields),
    provider_usage_unknown_fields: unknownFieldNames(usage, usageFields),
    provider_usage_has_only_expected_fields: usageHasOnlyExpectedFields,
    provider_usage_values_are_nonnegative_integers: usageValuesAreNonnegativeIntegers,
    provider_usage_values_fit_reservation: usageValuesFitReservation,
    provider_usage_processed_is_nonzero: usageProcessedIsNonzero,
    provider_usage_processed_fits_total: usageProcessedFitsTotal,
    provider_usage_outcomes_fit_processed: usageOutcomesFitProcessed,
    merchant_name_is_valid: isBoundedText(receipt?.merchant_name, 160, { optional: true }),
    purchase_date_is_valid: isOptionalExactDate(receipt?.purchase_date),
    receipt_total_is_valid: receiptTotalMissing || isPositiveBoundedNumber(receiptTotal, MAX_MONEY),
    line_items_are_valid_records: itemsAreRecords,
    line_item_names_are_valid: itemsAreRecords && itemRecords.every(item => isBoundedText(item.name, 160)),
    line_item_quantities_are_valid: itemsAreRecords && itemRecords.every(item => isPositiveBoundedNumber(item.quantity, MAX_QUANTITY)),
    line_item_units_are_valid: itemsAreRecords && itemRecords.every(item => isBoundedText(item.unit, 30, { optional: true })),
    line_item_totals_are_valid: itemsAreRecords && itemRecords.every(item => boundedNumber(item.line_total, MAX_MONEY) != null)
  };
}

export function validateProviderUsage(payload, maxPages, { allowZero = false } = {}) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object" || !Number.isInteger(maxPages) || maxPages < 1) throw new Error("invalid_provider_result");
  const fields = providerUsageFields;
  if (Object.keys(usage).some(key => !fields.includes(key))) throw new Error("invalid_provider_result");
  if (requiredProviderUsageFields.some(key => !Number.isInteger(usage[key]) || usage[key] < 0 || usage[key] > maxPages)) throw new Error("invalid_provider_result");
  if (optionalProviderUsageFields.some(key => usage[key] !== undefined && (!Number.isInteger(usage[key]) || usage[key] < 0 || usage[key] > maxPages))) throw new Error("invalid_provider_result");
  if ((!allowZero && usage.pages_processed < 1) || usage.pages_processed > usage.pages_total || usage.pages_succeeded + usage.pages_failed > usage.pages_processed) throw new Error("invalid_provider_result");
  return usage;
}

export function providerState(payload, expectedJobId, maxPages) {
  if (!payload || typeof payload !== "object" || cleanStatus(payload.job_id, 160) !== expectedJobId) throw new Error("invalid_provider_result");
  // The status endpoint is provider control-plane metadata, not schema output.
  // Read only the fields that govern our state machine and deliberately ignore
  // future provider fields: they are never logged, persisted, or returned.
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
  // The provider may add envelope metadata around a completed result. It is not
  // part of the caller's schema and is deliberately ignored rather than logged,
  // persisted, or exposed. The schema-shaped `result` remains strict below.
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
    const name = reviewedItemName(item.name, display_order);
    const quantity = boundedNumber(item.quantity, MAX_QUANTITY);
    const unit = boundedText(item.unit, 30, { optional: true }) || null;
    const line_total = boundedNumber(item.line_total, MAX_MONEY);
    if (line_total == null || quantity == null || quantity <= 0) throw new Error("invalid_provider_result");
    return { name, quantity, unit, unit_price: null, line_total, is_personal: false, is_tracked_for_restock: true, estimated_use_by: null, display_order };
  });
  const itemTotal = items.reduce((sum, item) => sum + item.line_total, 0);
  const receiptTotalMissing = receipt.receipt_total == null || receipt.receipt_total === "";
  // A table-only privacy derivative intentionally excludes the final receipt
  // total. In that one case the validated positive line totals are the only
  // amount returned to the local review draft. A supplied provider total is
  // never replaced or masked: it must be bounded, positive and reconcile.
  if (receiptTotalMissing && items.some(item => item.line_total <= 0)) throw new Error("invalid_provider_result");
  const amount = receiptTotalMissing ? itemTotal : boundedNumber(receipt.receipt_total, MAX_MONEY);
  if (amount == null || amount <= 0 || amount > MAX_MONEY || (!receiptTotalMissing && Math.abs(amount - itemTotal) > .01)) throw new Error("invalid_provider_result");
  const label = boundedText(receipt.merchant_name, 160, { optional: true });
  return { defaults: { label, category: "Groceries", amount: amount.toFixed(2), date: optionalExactDate(receipt.purchase_date) }, items };
}

export function fixedCompletionError(error) {
  const allowed = new Set(["authentication_required","origin_not_allowed","processing_disabled","job_not_found","job_expired","completion_timeout","submission_retry_exhausted","provider_pending","provider_failed","provider_unavailable","invalid_provider_result","provider_access_denied","provider_job_unavailable","provider_request_rejected","provider_rate_limited","provider_timeout","provider_connection_failed","provider_service_unavailable"]);
  return allowed.has(error?.message) ? error.message : "provider_unavailable";
}
