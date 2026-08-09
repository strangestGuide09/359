export const RECEIPT_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    merchant_name: { type: "string", description: "Merchant or store name only. Never return customer names, addresses, contact details, payment details, order identifiers or invoice identifiers." },
    purchase_date: { type: "string", description: "Purchase date in YYYY-MM-DD format only. Never return an order or invoice identifier." },
    receipt_total: { type: "number", description: "Final paid or payable receipt total only." },
    currency: { type: "string", enum: ["INR"], description: "ISO 4217 receipt currency. Return INR only." },
    line_items: {
      type: "array",
      description: "Purchased product and explicit fee lines only. Never return payment, address, contact, order, invoice, customer, tax-summary or identifier fields.",
      items: {
        type: "object",
        description: "One purchased item or explicit fee line, with only the approved receipt fields.",
        properties: {
          name: { type: "string", description: "Purchased item or explicit fee name." },
          quantity: { type: "number", description: "Purchased quantity when stated; use 1 when the receipt clearly shows one item." },
          unit: { type: "string", description: "Package or quantity unit when stated, otherwise an empty string." },
          line_total: { type: "number", description: "Final line total in INR after line-level discount." }
        },
        required: ["name","quantity","line_total"]
      }
    }
  },
  required: ["merchant_name","purchase_date","receipt_total","currency","line_items"]
};

export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
export const PROVIDER_TIMEOUT_MS = 45_000;

export async function boundedProviderJson(url, init, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(response.status === 409 ? "provider_pending" : "provider_unavailable");
      error.status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) throw new Error("invalid_provider_result");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error("invalid_provider_result");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("provider_unavailable");
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error("invalid_provider_result"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    bytes.fill(0);
    try { return JSON.parse(text); } catch { throw new Error("invalid_provider_result"); }
  } catch (error) {
    console.error(JSON.stringify(providerFailureDiagnostic(error, controller.signal.aborted)));
    if (controller.signal.aborted || error?.name === "AbortError") throw new Error("provider_timeout");
    throw error;
  } finally { clearTimeout(timer); }
}

export function providerFailureDiagnostic(error, timedOut) {
  const source = error && typeof error === "object" ? error : {};
  const cause = source.cause && typeof source.cause === "object" ? source.cause : {};
  const boundedToken = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "unknown";
  const httpStatus = Number(source.status);
  return {
    event: "sarvam_provider_failure",
    timed_out: timedOut === true,
    http_status: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    error_name: boundedToken(source.name),
    cause_name: boundedToken(cause.name),
    cause_code: boundedToken(cause.code)
  };
}
