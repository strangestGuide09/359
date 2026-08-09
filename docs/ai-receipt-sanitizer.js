export const AI_SANITIZER_VERSION = "web-v1";
export const MAX_SANITIZED_LINES = 48;

const privateLine = /(?:\b(?:customer|buyer|recipient|deliver(?:y|ed)?|ship(?:ping|ped)?|bill(?:ing|ed)?|address|phone|mobile|email|e-mail|contact|landmark|payment|card|upi|transaction|reference|account|bank|order\s*(?:id|number|no)|invoice\s*(?:id|number|no))\b|@|\b(?:\+?91[\s-]?)?[6-9]\d{9}\b|\b\d{4}[\s-]?\d{4}[\s-]?\d{4}(?:[\s-]?\d{4})?\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
const opaqueIdentifier = /\b[a-z0-9]{18,}\b/i;

const cleanLine = value => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

export function suggestedSanitizedLines(parsed) {
  const allowed = [];
  if (parsed?.defaults?.label) allowed.push(`Merchant: ${parsed.defaults.label}`);
  if (parsed?.defaults?.date) allowed.push(`Purchase date: ${parsed.defaults.date}`);
  for (const item of parsed?.items || []) {
    const parts = [cleanLine(item.name), item.quantity ? `qty ${item.quantity}` : "", item.unit ? cleanLine(item.unit) : "", item.line_total != null ? `total ${item.line_total}` : ""].filter(Boolean);
    if (parts.length) allowed.push(`Item: ${parts.join(" | ")}`);
  }
  if (parsed?.defaults?.amount) allowed.push(`Receipt total: ${parsed.defaults.amount}`);
  return validateSanitizedText(allowed.slice(0, MAX_SANITIZED_LINES).join("\n"));
}

export function validateSanitizedText(value) {
  const lines = String(value ?? "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length) throw new Error("Add at least one non-private receipt line.");
  if (lines.length > MAX_SANITIZED_LINES) throw new Error(`Keep the sanitized preview to ${MAX_SANITIZED_LINES} lines or fewer.`);
  const unsafe = lines.find(line => privateLine.test(line) || opaqueIdentifier.test(line));
  if (unsafe) throw new Error("Remove customer, address, contact, payment, order, invoice-ID, or other identifying details.");
  return lines;
}

const pdfEscape = value => value.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");

export function buildSanitizedPdf(value) {
  const lines = validateSanitizedText(value);
  const content = ["BT", "/F1 10 Tf", "44 790 Td", "12 TL", ...lines.flatMap((line, index) => [index ? "T*" : "", `(${pdfEscape(line)}) Tj`]).filter(Boolean), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = `%PDF-1.4\n%GROCERY-LEDGER-SANITIZED:${AI_SANITIZER_VERSION}\n`;
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([new TextEncoder().encode(pdf)], { type: "application/pdf" });
}

export function aiParseMessage(code) {
  return ({
    processing_disabled: "AI receipt improvement is not enabled yet. Your local draft is unchanged.",
    authentication_required: "Your session must be refreshed before using AI receipt improvement.",
    origin_not_allowed: "AI receipt improvement is not available from this site address.",
    rate_or_cap_reached: "The private AI usage limit has been reached. Use the local draft or try later.",
    invalid_payload_size: "The sanitized derivative is too large.",
    sanitized_derivative_required: "The sanitized derivative could not be prepared.",
    provider_unavailable: "The AI provider is temporarily unavailable. Your local draft is unchanged.",
    job_not_found: "This AI receipt job is unavailable for the current household.",
    job_expired: "The AI receipt job expired. Your local draft is unchanged.",
    completion_timeout: "AI receipt processing took too long. Your local draft is unchanged.",
    submission_retry_exhausted: "AI receipt processing could not start safely after several attempts. Your local draft is unchanged.",
    provider_failed: "The AI provider could not process this redacted derivative. Your local draft is unchanged.",
    invalid_provider_result: "The AI result did not pass Grocery Ledger’s safety checks. Your local draft is unchanged."
  })[code] || "AI receipt improvement could not start. Your local draft is unchanged.";
}
