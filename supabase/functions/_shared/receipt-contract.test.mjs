import assert from "node:assert/strict";
import test from "node:test";
import { RECEIPT_EXTRACTION_SCHEMA } from "./receipt-contract.mjs";

test("Document AI Extract schema requests only the reviewed receipt allowlist", () => {
  assert.deepEqual(Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties).sort(), ["currency","line_items","merchant_name","purchase_date","receipt_total"]);
  assert.deepEqual(Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties.line_items.items.properties).sort(), ["line_total","name","quantity","unit"]);
  const requestedKeys = [...Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties), ...Object.keys(RECEIPT_EXTRACTION_SCHEMA.properties.line_items.items.properties)];
  assert.ok(requestedKeys.every(key => !["customer_name","address","phone","email","payment_method","order_id"].includes(key)));
});
