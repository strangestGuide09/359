import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("integration uses only current Document AI Extract, status, and results endpoints", async () => {
  const [submit, result] = await Promise.all([
    readFile(new URL("../sarvam-receipt-parse/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./index.ts", import.meta.url), "utf8")
  ]);
  const source = `${submit}\n${result}`;
  assert.match(submit, /https:\/\/api\.sarvam\.ai\/doc-ai\/v1\/job\/extract/);
  assert.match(result, /\/doc-ai\/v1\/job\/\$\{encodeURIComponent\(providerJobId\)\}\/status/);
  assert.match(result, /\/doc-ai\/v1\/job\/\$\{encodeURIComponent\(providerJobId\)\}\/results\?format=json/);
  assert.doesNotMatch(source, /doc-digitization|upload-files|download-files|\/start\b/);
  assert.match(submit, /form\.set\("file"/);
  assert.match(submit, /form\.set\("schema"/);
  assert.doesNotMatch(submit, /upload_ids|config_id/);
});
