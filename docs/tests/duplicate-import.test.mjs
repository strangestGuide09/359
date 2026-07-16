import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicateImportError, sameFingerprint } from "../duplicate-import.js";

test("same PDF uploads match exact or normalized-content fingerprints", () => {
  const first = { exactHash: "exact-a", contentHash: "content-a" };
  assert.equal(sameFingerprint(first, { exactHash: "exact-a", contentHash: "content-b" }), true);
  assert.equal(sameFingerprint(first, { exactHash: "exact-b", contentHash: "content-a" }), true);
  assert.equal(sameFingerprint(first, { exactHash: "exact-b", contentHash: "content-b" }), false);
});

test("duplicate reviewed-purchase RPC responses are recognized", () => {
  assert.equal(isDuplicateImportError({ message: "This bill was already imported" }), true);
  assert.equal(isDuplicateImportError({ code: "23505", message: "duplicate key value violates unique constraint" }), true);
  assert.equal(isDuplicateImportError({ message: "duplicate key", details: "invoice_imports_content_hash_key" }), true);
});

test("ordinary save failures are not mislabeled as duplicates", () => {
  assert.equal(isDuplicateImportError({ code: "42501", message: "permission denied" }), false);
  assert.equal(isDuplicateImportError({ message: "network request failed" }), false);
});
