import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiReceiptTotal } from "../ai-receipt-total.js";

test("a valid local total remains authoritative when AI totals differ", () => {
  assert.deepEqual(resolveAiReceiptTotal("228.99", "227.43", [{ line_total: 100 }, { line_total: 127.43 }]), {
    amount: "228.99",
    warning: "The AI item totals differ from the locally identified receipt total. The local receipt total was kept; review the AI line items before saving."
  });
});

test("currency rounding avoids false mismatch warnings", () => {
  assert.deepEqual(resolveAiReceiptTotal("228.990", 228.99, [{ line_total: 100.004 }, { line_total: 128.986 }]), { amount: "228.99", warning: "" });
});

test("AI amount is used only when the local total is absent or invalid", () => {
  assert.deepEqual(resolveAiReceiptTotal("", "2360.04", [{ line_total: 2360.04 }]), { amount: "2360.04", warning: "" });
  assert.deepEqual(resolveAiReceiptTotal("not confirmed", 145, [{ line_total: 145 }]), { amount: "145.00", warning: "" });
});
