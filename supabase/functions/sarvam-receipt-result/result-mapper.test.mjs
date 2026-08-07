import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixedCompletionError, mapProviderReceipt, providerState } from "./result-mapper.mjs";

test("provider status is bound to the expected submitted job", () => {
  assert.equal(providerState({ job_id: "provider-1", status: "running", pipeline: "extract" }, "provider-1"), "pending");
  assert.equal(providerState({ job_id: "provider-1", status: "completed", pipeline: "extract" }, "provider-1"), "completed");
  assert.throws(() => providerState({ job_id: "other", status: "completed", pipeline: "extract" }, "provider-1"), /invalid_provider_result/);
});

test("synthetic structured output maps only reviewed draft fields", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/completed-receipt.json", import.meta.url), "utf8"));
  const draft = mapProviderReceipt(fixture, "provider-1");
  assert.deepEqual(Object.keys(draft).sort(), ["defaults","items"]);
  assert.deepEqual(Object.keys(draft.items[0]).sort(), ["display_order","estimated_use_by","is_personal","is_tracked_for_restock","line_total","name","quantity","unit","unit_price"]);
  assert.doesNotMatch(JSON.stringify(draft), /customer|raw_text|must not escape/);
});

test("malformed, oversized, or unreconciled drafts fail closed", () => {
  assert.throws(() => mapProviderReceipt({ job_id: "p", type: "digitise", status: "completed", result: { text: "unstructured OCR" } }, "p"), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt({ job_id: "p", type: "extract", status: "completed", result: { merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 100, currency: "INR", line_items: [{ name: "Milk", quantity: 1, line_total: 90 }] } }, "p"), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt({ job_id: "p", type: "extract", status: "completed", result: { merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", line_items: Array.from({ length: 101 }, () => ({ name: "x", quantity: 1, line_total: 0.01 })) } }, "p"), /invalid_provider_result/);
  assert.throws(() => mapProviderReceipt({ job_id: "p", type: "extract", status: "completed", result: { merchant_name: "Shop", purchase_date: "2026-08-07", receipt_total: 1, currency: "INR", customer_name: "forbidden", line_items: [{ name: "x", quantity: 1, line_total: 1 }] } }, "p"), /invalid_provider_result/);
});

test("unknown failures collapse to a fixed privacy-safe code", () => {
  assert.equal(fixedCompletionError(new Error("secret provider body")), "provider_unavailable");
  assert.equal(fixedCompletionError(new Error("job_expired")), "job_expired");
});
