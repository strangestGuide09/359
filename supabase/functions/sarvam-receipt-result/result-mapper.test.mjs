import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixedCompletionError, mapProviderReceipt, providerState, providerStatusShapeDiagnostic, resultShapeDiagnostic, validateProviderUsage } from "./result-mapper.mjs";

const usage = { pages_total: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0, pages_discarded: 0 };
const statusUsage = { pages_total: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0 };

test("provider status is bound to the expected submitted job", () => {
  assert.equal(providerState({ job_id: "provider-1", status: "running", pipeline: "extract", usage }, "provider-1", 1), "pending");
  assert.equal(providerState({ job_id: "provider-1", run_id: "run-1", status: "pending", pipeline: "extract", usage }, "provider-1", 1), "pending");
  assert.equal(providerState({ job_id: "provider-1", status: "pending", pipeline: "extract", usage: statusUsage }, "provider-1", 1), "pending");
  assert.equal(providerState({ job_id: "provider-1", status: "completed", pipeline: "extract", usage }, "provider-1", 1), "completed");
  assert.equal(providerState({ job_id: "provider-1", status: "pending", pipeline: "extract", usage, retryAfterSeconds: 3 }, "provider-1", 1), "pending");
  assert.throws(() => providerState({ job_id: "other", status: "completed", pipeline: "extract", usage }, "provider-1", 1), /invalid_provider_result/);
  assert.throws(() => providerState({ job_id: "provider-1", status: "completed", pipeline: "wrong", usage }, "provider-1", 1), /invalid_provider_result/);
});

test("synthetic structured output maps only reviewed draft fields", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const draft = mapProviderReceipt(fixture, "provider-1", 1);
  const withFutureEnvelopeMetadata = mapProviderReceipt({ ...fixture, provider_trace: "ignored" }, "provider-1", 1);
  const withoutOptionalDiscardedPages = mapProviderReceipt({ ...fixture, usage: statusUsage }, "provider-1", 1);
  assert.deepEqual(Object.keys(draft).sort(), ["defaults","items"]);
  assert.deepEqual(withFutureEnvelopeMetadata, draft);
  assert.deepEqual(withoutOptionalDiscardedPages, draft);
  assert.deepEqual(Object.keys(draft.items[0]).sort(), ["display_order","estimated_use_by","is_personal","is_tracked_for_restock","line_total","name","quantity","unit","unit_price"]);
  assert.doesNotMatch(JSON.stringify(draft), /customer|raw_text|must not escape/);
});

test("rejected-result diagnostics expose shape but never extracted values", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const diagnostic = resultShapeDiagnostic(fixture, "provider-1", 1);
  assert.deepEqual(diagnostic.result_fields, { merchant_name: true, purchase_date: true, receipt_total: true, currency: true, line_items: true });
  assert.equal(diagnostic.first_line_item_fields.name, true);
  assert.equal(diagnostic.amounts_reconcile, true);
  assert.equal(diagnostic.provider_usage_is_valid, true);
  assert.equal(diagnostic.provider_usage_has_only_expected_fields, true);
  assert.equal(diagnostic.provider_usage_values_are_nonnegative_integers, true);
  assert.equal(diagnostic.provider_usage_values_fit_reservation, true);
  assert.equal(diagnostic.provider_usage_processed_is_nonzero, true);
  assert.equal(diagnostic.provider_usage_processed_fits_total, true);
  assert.equal(diagnostic.provider_usage_outcomes_fit_processed, true);
  assert.equal(diagnostic.merchant_name_is_valid, true);
  assert.equal(diagnostic.purchase_date_is_valid, true);
  assert.equal(diagnostic.receipt_total_is_valid, true);
  assert.equal(diagnostic.line_items_are_valid_records, true);
  assert.equal(diagnostic.line_item_names_are_valid, true);
  assert.equal(diagnostic.line_item_quantities_are_valid, true);
  assert.equal(diagnostic.line_item_units_are_valid, true);
  assert.equal(diagnostic.line_item_totals_are_valid, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /Shop|Milk|2026-08-07|100/);
});

test("rejected-result diagnostics identify a rule without exposing result values", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const malformed = { ...fixture, result: { ...fixture.result, purchase_date: "not-a-date" } };
  const diagnostic = resultShapeDiagnostic(malformed, "provider-1", 1);
  assert.equal(diagnostic.purchase_date_is_valid, false);
  assert.equal(diagnostic.merchant_name_is_valid, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /not-a-date|Shop|Milk/);
});

test("rejected-result diagnostics isolate usage rules without exposing usage values", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const malformed = { ...fixture, usage: { ...fixture.usage, provider_latency_ms: 42 } };
  const diagnostic = resultShapeDiagnostic(malformed, "provider-1", 1);
  assert.equal(diagnostic.provider_usage_is_valid, false);
  assert.equal(diagnostic.provider_usage_has_only_expected_fields, false);
  assert.equal(diagnostic.provider_usage_unknown_field_count, 1);
  assert.deepEqual(diagnostic.provider_usage_unknown_fields, ["provider_latency_ms"]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /42|Shop|Milk/);
});

test("status diagnostics expose structure but never provider values", () => {
  const diagnostic = providerStatusShapeDiagnostic({ job_id: "provider-1", status: "completed", pipeline: "extract", usage, retryAfterSeconds: 3 }, "provider-1");
  assert.equal(diagnostic.payload_expected_job_matches, true);
  assert.equal(diagnostic.pipeline_is_extract, true);
  assert.equal(diagnostic.provider_status, "completed");
  assert.deepEqual(diagnostic.payload_unknown_fields, ["retryAfterSeconds"]);
  assert.deepEqual(diagnostic.usage_fields, { pages_total: true, pages_processed: true, pages_succeeded: true, pages_failed: true, pages_discarded: true });
  assert.doesNotMatch(JSON.stringify(diagnostic), /provider-1/);
});

test("malformed, oversized, or unreconciled drafts fail closed", () => {
  const wrap = result => ({ job_id: "p", type: "extract", status: "completed", usage, result });
  assert.throws(() => mapProviderReceipt({ job_id: "p", type: "digitise", status: "completed", usage, result: { text: "unstructured OCR" } }, "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 100, currency: "INR", line_items: [{ name: "Milk", quantity: 1, line_total: 90 }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", line_items: Array.from({ length: 101 }, () => ({ name: "x", quantity: 1, line_total: 0.01 })) }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", customer_name: "forbidden", line_items: [{ name: "x", quantity: 1, line_total: 1 }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-02-30", receipt_total: 0, currency: "INR", line_items: [{ name: "x", quantity: 1, line_total: null }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "x".repeat(161), purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", line_items: [{ name: "x", quantity: 1, line_total: 1 }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", raw_document: "forbidden", line_items: [{ name: "x", quantity: 1, line_total: 1 }] }), "p", 1), /invalid_provider_result/);
});

test("provider usage cannot exceed the sanitized derivative page reservation", () => {
  assert.deepEqual(validateProviderUsage({ usage }, 1), usage);
  assert.deepEqual(validateProviderUsage({ usage: statusUsage }, 1), statusUsage);
  assert.throws(() => validateProviderUsage({ usage: { ...usage, pages_total: 2, pages_processed: 2, pages_succeeded: 2 } }, 1), /invalid_provider_result/);
  assert.throws(() => validateProviderUsage({ usage: { ...usage, pages_succeeded: 1, pages_failed: 1 } }, 1), /invalid_provider_result/);
  assert.throws(() => validateProviderUsage({ usage: { ...statusUsage, pages_discarded: "one" } }, 1), /invalid_provider_result/);
  assert.throws(() => validateProviderUsage({ usage: { ...usage, raw_pages: 1 } }, 1), /invalid_provider_result/);
});

test("unknown failures collapse to a fixed privacy-safe code", () => {
  assert.equal(fixedCompletionError(new Error("secret provider body")), "provider_unavailable");
  assert.equal(fixedCompletionError(new Error("job_expired")), "job_expired");
  assert.equal(fixedCompletionError(new Error("provider_timeout")), "provider_timeout");
  assert.equal(fixedCompletionError(new Error("provider_job_unavailable")), "provider_job_unavailable");
  assert.equal(fixedCompletionError(new Error("provider_service_unavailable")), "provider_service_unavailable");
});
