export function isDuplicateImportError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();
  return code === "23505"
    || /already imported/.test(message)
    || (/duplicate key|unique constraint/.test(`${message} ${details}`) && /invoice_imports|exact_pdf_hash|content_hash/.test(`${message} ${details}`));
}

export function sameFingerprint(left, right) {
  return !!left && !!right && (left.exactHash === right.exactHash || left.contentHash === right.contentHash);
}
