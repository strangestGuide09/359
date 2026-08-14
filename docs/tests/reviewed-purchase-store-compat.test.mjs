import assert from "node:assert/strict";
import test from "node:test";
import { importReviewedPurchase, isMissingReviewedImportSignature } from "../reviewed-purchase-store.js";

const values = { p_household_id: "household", p_paid_by: "payer", p_exact_pdf_hash: "exact-hash", p_content_hash: "sparse-content", p_content_hash_reliable: false, p_label: "Invoice", p_category: "Groceries", p_amount: 871, p_purchased_on: "2026-08-13", p_is_personal: false, p_items: [{ name: "Boondi", line_total: 75 }] };

test("current backend receives reliability and succeeds without retry", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: "purchase-new", error: null }; } };
  const result = await importReviewedPurchase(client, values);
  assert.equal(result.data, "purchase-new");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].p_content_hash_reliable, false);
  assert.equal(calls[0][1].p_content_hash, "sparse-content");
});

test("legacy backend retries only its old signature and replaces unreliable content hash with exact hash", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (calls.length === 1) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.import_reviewed_purchase(p_content_hash_reliable) in the schema cache" } };
    return { data: "purchase-legacy", error: null };
  } };
  const result = await importReviewedPurchase(client, values);
  assert.equal(result.data, "purchase-legacy");
  assert.equal(calls.length, 2);
  assert.equal("p_content_hash_reliable" in calls[1][1], false);
  assert.equal(calls[1][1].p_content_hash, "exact-hash");
  assert.equal(calls[1][1].p_exact_pdf_hash, "exact-hash");
});

test("reliable content fingerprint is retained for a legacy signature", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push(args); return calls.length === 1 ? { error: { code: "42883", message: "function import_reviewed_purchase(...) does not exist" } } : { data: "ok", error: null }; } };
  await importReviewedPurchase(client, { ...values, p_content_hash: "reliable-content", p_content_hash_reliable: true });
  assert.equal(calls[1].p_content_hash, "reliable-content");
});

test("business and validation errors never trigger the legacy retry", async () => {
  for (const error of [
    { code: "23514", message: "Reviewed item totals do not match" },
    { code: "PGRST202", message: "Could not find a different function in the schema cache" },
    { code: "42501", message: "Not authorized" }
  ]) {
    let calls = 0;
    const result = await importReviewedPurchase({ rpc: async () => { calls += 1; return { data: null, error }; } }, values);
    assert.equal(calls, 1);
    assert.equal(result.error, error);
  }
});

test("both signatures failing returns a clear upgrade message and leaves caller draft handling intact", async () => {
  let calls = 0;
  const result = await importReviewedPurchase({ rpc: async () => {
    calls += 1;
    return calls === 1
      ? { error: { code: "PGRST202", message: "Could not find import_reviewed_purchase in the schema cache" } }
      : { error: { code: "PGRST202", message: "Legacy import_reviewed_purchase is also unavailable" } };
  } }, values);
  assert.equal(calls, 2);
  assert.match(result.error.message, /database must be upgraded/i);
  assert.match(result.error.message, /draft is still here/i);
});

test("missing signature classification is deliberately narrow", () => {
  assert.equal(isMissingReviewedImportSignature({ code: "PGRST202", message: "Could not find import_reviewed_purchase in the schema cache" }), true);
  assert.equal(isMissingReviewedImportSignature({ code: "42883", message: "function import_reviewed_purchase does not exist" }), true);
  assert.equal(isMissingReviewedImportSignature({ code: "PGRST204", message: "Column missing" }), false);
});
