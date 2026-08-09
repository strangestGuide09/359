import assert from "node:assert/strict";
import test from "node:test";
import { fixedError, hasAllowedMagic, inspectSanitizedPdf, MAX_DERIVATIVE_BYTES, validateMetadata } from "./validation.mjs";

const valid = { householdId:"a129ba64-9e57-42df-ac0b-ae137c33dd76",idempotencyKey:"550e8400-e29b-41d4-a716-446655440000",sanitizerVersion:"receipt-redactor-1",mime:"application/pdf",pageCount:2,byteCount:1024,sanitized:"true" };

test("accepts bounded sanitized derivative metadata",()=>assert.doesNotThrow(()=>validateMetadata(valid)));
test("rejects missing attestation, oversize, pages, and MIME",()=>{
  for (const patch of [{sanitized:"false"},{byteCount:MAX_DERIVATIVE_BYTES+1},{pageCount:6},{mime:"application/zip"}]) {
    assert.throws(()=>validateMetadata({...valid,...patch}));
  }
});
test("checks PDF magic bytes",()=>{
  assert.equal(hasAllowedMagic(new TextEncoder().encode("%PDF-1.7"),"application/pdf"),true);
  assert.equal(hasAllowedMagic(new TextEncoder().encode("PKZIP"),"application/pdf"),false);
});
test("requires sanitizer marker, exact pages, and passive PDF",()=>{
  const safe = new TextEncoder().encode("%PDF-1.7\n%GROCERY-LEDGER-SANITIZED:receipt-redactor-1\n/Type /Page\n");
  assert.doesNotThrow(()=>inspectSanitizedPdf(safe,"receipt-redactor-1",1));
  assert.throws(()=>inspectSanitizedPdf(safe,"other",1),/sanitized_derivative_required/);
  assert.throws(()=>inspectSanitizedPdf(safe,"receipt-redactor-1",2),/invalid_page_count/);
  const active = new TextEncoder().encode("%PDF-1.7\n%GROCERY-LEDGER-SANITIZED:receipt-redactor-1\n/Type /Page /JavaScript\n");
  assert.throws(()=>inspectSanitizedPdf(active,"receipt-redactor-1",1),/unsafe_pdf_feature/);
});
test("unknown errors collapse to fixed provider code",()=>assert.equal(fixedError(new Error("secret provider detail")),"provider_unavailable"));
test("provider HTTP statuses map to privacy-safe recovery codes",()=>{
  assert.equal(fixedError(Object.assign(new Error("provider body"),{status:403})),"provider_access_denied");
  assert.equal(fixedError(Object.assign(new Error("provider body"),{status:400})),"provider_request_rejected");
  assert.equal(fixedError(Object.assign(new Error("provider body"),{status:429})),"provider_rate_limited");
  assert.equal(fixedError(Object.assign(new Error("provider body"),{status:503})),"provider_service_unavailable");
});
test("submission-stage diagnostics remain fixed and content-free",()=>{
  for (const code of ["provider_invalid_response","provider_connection_failed","provider_job_record_failed","submission_claim_failed","provider_timeout"]) {
    assert.equal(fixedError(new Error(code)),code);
  }
});
