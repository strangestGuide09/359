import assert from "node:assert/strict";
import test from "node:test";
import { AI_SANITIZER_VERSION, aiParseMessage, buildSanitizedPdf, suggestedSanitizedLines, validateSanitizedText } from "../ai-receipt-sanitizer.js";

test("suggested lines use only already-allowed local draft fields", () => {
  const lines = suggestedSanitizedLines({ defaults: { label: "Instamart", date: "2026-08-07", amount: "65.00" }, items: [{ name: "Fresh Milk", quantity: 1, unit: "L", line_total: 65 }], extractedText: "Delivery address: 9 Private Road\nPhone 9876543210" });
  assert.deepEqual(lines, ["Merchant: Instamart", "Purchase date: 2026-08-07", "Item: Fresh Milk | qty 1 | L | total 65", "Receipt total: 65.00"]);
  assert.doesNotMatch(lines.join("\n"), /Private Road|9876543210/);
});

test("manual preview cannot retain common private identifiers", () => {
  assert.throws(() => validateSanitizedText("Rice 120\ncustomer@example.com"), /Remove customer/);
  assert.throws(() => validateSanitizedText("Rice 120\nOrder ID abcdefghijklmnopqrst"), /Remove customer/);
});

test("rebuilt derivative is a bounded marked PDF with one page", async () => {
  const bytes = new Uint8Array(await buildSanitizedPdf("Fresh Milk 65.00\nGrand Total 65.00").arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.slice(0, 2048).includes(`%GROCERY-LEDGER-SANITIZED:${AI_SANITIZER_VERSION}`));
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1);
  assert.doesNotMatch(text, /customer@example|Private Road/);
});

test("disabled processing has a non-destructive explanation", () => {
  assert.match(aiParseMessage("processing_disabled"), /not enabled yet/i);
  assert.match(aiParseMessage("provider_access_denied"), /API key|Extract access/i);
  assert.match(aiParseMessage("provider_request_rejected"), /rejected/i);
  assert.match(aiParseMessage("completion_timeout"), /too long/i);
  assert.match(aiParseMessage("invalid_provider_result"), /safety checks/i);
});
