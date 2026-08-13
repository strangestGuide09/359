export function isDuplicateImportError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();
  return code === "23505"
    || /already imported/.test(message)
    || (/duplicate key|unique constraint/.test(`${message} ${details}`) && /invoice_imports|exact_pdf_hash|content_hash/.test(`${message} ${details}`));
}

export function sameFingerprint(left, right) {
  return !!left && !!right && (left.exactHash === right.exactHash
    || (left.contentHashReliable !== false && right.contentHashReliable !== false && left.contentHash === right.contentHash));
}

export function contentFingerprintIsReliable(normalizedText) {
  const text = String(normalizedText || "").trim();
  const words = text.match(/[a-z]{3,}/g) || [];
  const meaningful = new Set(words.filter(word => !["invoice", "total", "amount", "date", "page"].includes(word)));
  return text.length >= 120 && meaningful.size >= 8;
}
