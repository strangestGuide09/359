import assert from "node:assert/strict";
import test from "node:test";
import { boundedProviderJson, RECEIPT_EXTRACTION_SCHEMA } from "./receipt-contract.mjs";

test("Document AI Extract schema requests only the reviewed receipt allowlist", () => {
  assert.deepEqual(Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties).sort(), ["currency","line_items","merchant_name","purchase_date","receipt_total"]);
  assert.deepEqual(Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties.line_items.items.properties).sort(), ["line_total","name","quantity","unit"]);
  const requestedKeys = [...Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties), ...Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties.line_items.items.properties)];
  assert.ok(requestedKeys.every(key => !["customer_name","address","phone","email","payment_method","order_id"].includes(key)));
});

test("provider JSON reader rejects declared, streamed, typed, and syntactic violations", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("{}", { headers: { "content-type": "text/plain" } });
  await assert.rejects(() => boundedProviderJson("https://example.invalid", {}, 10), /invalid_provider_result/);
  globalThis.fetch = async () => new Response("not-json", { headers: { "content-type": "application/json" } });
  await assert.rejects(() => boundedProviderJson("https://example.invalid", {}, 10), /invalid_provider_result/);
  globalThis.fetch = async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "11" } });
  await assert.rejects(() => boundedProviderJson("https://example.invalid", {}, 10), /invalid_provider_result/);
  globalThis.fetch = async () => new Response('     {"ok":true}', { headers: { "content-type": "application/json" } });
  await assert.rejects(() => boundedProviderJson("https://example.invalid", {}, 10), /invalid_provider_result/);
});
