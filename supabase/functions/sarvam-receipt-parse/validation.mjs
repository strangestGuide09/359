export const MAX_DERIVATIVE_BYTES = 4 * 1024 * 1024;
export const MAX_DERIVATIVE_PAGES = 5;
export const ALLOWED_MIME = new Set(["application/pdf"]);

export function validateMetadata({ householdId, idempotencyKey, sanitizerVersion, mime, pageCount, byteCount, sanitized }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(householdId || "")) throw new Error("invalid_household");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey || "")) throw new Error("invalid_idempotency_key");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(sanitizerVersion || "")) throw new Error("invalid_sanitizer_version");
  if (sanitized !== "true") throw new Error("sanitized_derivative_required");
  if (!ALLOWED_MIME.has(mime)) throw new Error("unsupported_derivative_type");
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_DERIVATIVE_PAGES) throw new Error("invalid_page_count");
  if (!Number.isInteger(byteCount) || byteCount < 1 || byteCount > MAX_DERIVATIVE_BYTES) throw new Error("invalid_payload_size");
}

export function hasAllowedMagic(bytes, mime) {
  if (mime === "application/pdf") return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  return false;
}

export function inspectSanitizedPdf(bytes, sanitizerVersion, declaredPages) {
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.slice(0, 2048).includes(`%GROCERY-LEDGER-SANITIZED:${sanitizerVersion}`)) throw new Error("sanitized_derivative_required");
  if (/\/(?:JavaScript|JS|EmbeddedFile|Launch|AcroForm|RichMedia|XFA)\b/.test(text)) throw new Error("unsafe_pdf_feature");
  const pages = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  if (pages !== declaredPages) throw new Error("invalid_page_count");
}

export function fixedError(error) {
  // These are deliberately coarse. They help an owner fix credentials or
  // throttling without exposing a provider response, document content, or URL.
  if ([401, 402, 403].includes(Number(error?.status))) return "provider_access_denied";
  if ([400, 413, 422].includes(Number(error?.status))) return "provider_request_rejected";
  if (Number(error?.status) === 429) return "provider_rate_limited";
  if (Number(error?.status) >= 500 && Number(error?.status) <= 599) return "provider_service_unavailable";
  const allowed = new Set([
    "invalid_household","invalid_idempotency_key","invalid_sanitizer_version",
    "sanitized_derivative_required","unsupported_derivative_type","invalid_page_count",
    "invalid_payload_size","invalid_file_signature","unsafe_pdf_feature","authentication_required",
    "origin_not_allowed","processing_disabled","rate_or_cap_reached","provider_unavailable",
    "provider_access_denied","provider_request_rejected","provider_rate_limited",
    "provider_invalid_response","provider_connection_failed","provider_job_record_failed",
    "submission_claim_failed","provider_timeout","provider_service_unavailable"
  ]);
  return allowed.has(error?.message) ? error.message : "provider_unavailable";
}
