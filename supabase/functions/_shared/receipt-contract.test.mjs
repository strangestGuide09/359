import assert from "node:assert/strict";
import test from "node:test";
import { boundedProviderJson, PROVIDER_TIMEOUT_MS, providerFailureDiagnostic, RECEIPT_EXTRACTION_SCHEMA } from "./receipt-contract.mjs";

test("Document AI Extract schema requests only the reviewed receipt allowlist", () => {
  assert.deepEqual(Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties).sort(), ["currency","line_items","merchant_name","purchase_date","receipt_total"]);
  assert.deepEqual(Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties.line_items.items.properties).sort(), ["line_total","name","quantity","unit"]);
  assert.match(RECEIPT_EXTRACTION_SCHEMA.properties.line_items.items.description, /purchased item/i);
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

test("provider request timeouts stay distinguishable from connection failures", async t => {
  assert.equal(PROVIDER_TIMEOUT_MS, 45_000);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new DOMException("aborted", "AbortError"); };
  await assert.rejects(() => boundedProviderJson("https://example.invalid", {}), /provider_timeout/);
});

test("provider diagnostics contain only fixed transport metadata", () => {
  assert.deepEqual(providerFailureDiagnostic(Object.assign(new Error("must not log"), { status: 503, cause: Object.assign(new Error("hidden"), { code: "ETIMEDOUT" }) }), true), {
    event: "sarvam_provider_failure", timed_out: true, http_status: 503,
    error_name: "Error", cause_name: "Error", cause_code: "ETIMEDOUT", transport_kind: "unknown", elapsed_ms: 0
  });
  assert.equal(providerFailureDiagnostic(new TypeError("error sending request: TLS certificate failure"), false, 123).transport_kind, "tls");
});
