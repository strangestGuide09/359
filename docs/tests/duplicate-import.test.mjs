import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicateImportError, sameFingerprint } from "../duplicate-import.js";
import { readFile } from "node:fs/promises";

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

test("only the database-approved legacy orphan path can release a fingerprint", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /duplicateState\(result\) === "legacy_unlinked"/);
  assert.match(app, /release_orphaned_invoice_fingerprints/);
  assert.match(app, /p_exact_pdf_hash: fingerprint\.exactHash/);
  assert.match(app, /p_content_hash: fingerprint\.contentHash/);
  assert.match(app, /if \(release\.error \|\| !release\.released\)/);
  assert.doesNotMatch(app, /from\("invoice_imports"\)\.delete/);
});
