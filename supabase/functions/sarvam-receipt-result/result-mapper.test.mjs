import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixedCompletionError, mapProviderReceipt, providerState, resultShapeDiagnostic, validateProviderUsage } from "./result-mapper.mjs";

const usage = { pages_total: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0 };

test("provider status is bound to the expected submitted job", () => {
  assert.equal(providerState({ job_id: "provider-1", status: "running", pipeline: "extract", usage }, "provider-1", 1), "pending");
  assert.equal(providerState({ job_id: "provider-1", status: "completed", pipeline: "extract", usage }, "provider-1", 1), "completed");
  assert.throws(() => providerState({ job_id: "other", status: "completed", pipeline: "extract", usage }, "provider-1", 1), /invalid_provider_result/);
  assert.throws(() => providerState({ job_id: "provider-1", status: "completed", pipeline: "extract", usage, raw_text: "forbidden" }, "provider-1", 1), /invalid_provider_result/);
});

test("synthetic structured output maps only reviewed draft fields", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const draft = mapProviderReceipt(fixture, "provider-1", 1);
  assert.deepEqual(Object.keys(draft).sort(), ["defaults","items"]);
  assert.deepEqual(Object.keys(draft.items[0]).sort(), ["display_order","estimated_use_by","is_personal","is_tracked_for_restock","line_total","name","quantity","unit","unit_price"]);
  assert.doesNotMatch(JSON.stringify(draft), /customer|raw_text|must not escape/);
});

test("rejected-result diagnostics expose shape but never extracted values", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const diagnostic = resultShapeDiagnostic(fixture, "provider-1");
  assert.deepEqual(diagnostic.result_fields, { merchant_name: true, purchase_date: true, receipt_total: true, currency: true, line_items: true });
  assert.equal(diagnostic.first_line_item_fields.name, true);
  assert.equal(diagnostic.amounts_reconcile, true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /Shop|Milk|2026-08-07|100/);
});

test("malformed, oversized, or unreconciled drafts fail closed", () => {
  const wrap = result => ({ job_id: "p", type: "extract", status: "completed", usage, result });
  assert.throws(() => mapProviderReceipt({ job_id: "p", type: "digitise", status: "completed", usage, result: { text: "unstructured OCR" } }, "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 100, currency: "INR", line_items: [{ name: "Milk", quantity: 1, line_total: 90 }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", line_items: Array.from({ length: 101 }, () => ({ name: "x", quantity: 1, line_total: 0.01 })) }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", customer_name: "forbidden", line_items: [{ name: "x", quantity: 1, line_total: 1 }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "Shop", purchase_date: "2026-02-30", receipt_total: 0, currency: "INR", line_items: [{ name: "x", quantity: 1, line_total: null }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt(wrap({ merchant_name: "x".repeat(161), purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", line_items: [{ name: "x", quantity: 1, line_total: 1 }] }), "p", 1), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt({ ...wrap({ merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", line_items: [{ name: "x", quantity: 1, line_total: 1 }] }), raw_document: "forbidden" }, "p", 1), /invalid_provider_result/);
});

test("provider usage cannot exceed the sanitized derivative page reservation", () => {
  assert.deepEqual(validateProviderUsage({ usage }, 1), usage);
  assert.throws(() => validateProviderUsage({ usage: { ...usage, pages_total: 2, pages_processed: 2, pages_succeeded: 2 } }, 1), /invalid_provider_result/);
  assert.throws(() => validateProviderUsage({ usage: { ...usage, pages_succeeded: 1, pages_failed: 1 } }, 1), /invalid_provider_result/);
  assert.throws(() => validateProviderUsage({ usage: { ...usage, raw_pages: 1 } }, 1), /invalid_provider_result/);
});

test("unknown failures collapse to a fixed privacy-safe code", () => {
  assert.equal(fixedCompletionError(new Error("secret provider body")), "provider_unavailable");
  assert.equal(fixedCompletionError(new Error("job_expired")), "job_expired");
  assert.equal(fixedCompletionError(new Error("provider_timeout")), "provider_timeout");
  assert.equal(fixedCompletionError(new Error("provider_job_unavailable")), "provider_job_unavailable");
  assert.equal(fixedCompletionError(new Error("provider_service_unavailable")), "provider_service_unavailable");
});
