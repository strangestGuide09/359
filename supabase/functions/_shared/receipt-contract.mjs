export const RECEIPT_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    merchant_name: { type: "string", description: "Merchant or store name only. Return an empty string if it is not visible. Never return customer names, addresses, contact details, payment details, order identifiers or invoice identifiers." },
    purchase_date: { type: "string", description: "Purchase date in YYYY-MM-DD format only. Return an empty string if it is not visible. Never return an order or invoice identifier." },
    receipt_total: { type: "number", description: "Final paid or payable receipt total only. Return null if that final total is not visible in the sanitized derivative; never infer it from unrelated receipt text." },
    // Sarvam Extract accepts its own compact schema dialect: type, description,
    // properties and items.  It rejects JSON Schema keywords such as `required`
    // and `enum`, so currency and field completeness are enforced after receipt
    // in result-mapper.mjs instead.
    currency: { type: "string", description: "ISO 4217 receipt currency. Return INR only." },
    line_items: {
      type: "array",
      description: "Purchased product and explicit fee lines only. Return an empty name when a row is readable but its product or fee name is not; never invent a name. Never return payment, address, contact, order, invoice, customer, tax-summary or identifier fields.",
      items: {
        type: "object",
        description: "One purchased item or explicit fee line, with only the approved receipt fields.",
        properties: {
          name: { type: "string", description: "Purchased item or explicit fee name." },
          quantity: { type: "number", description: "Purchased quantity when stated; use 1 when the receipt clearly shows one item." },
          unit: { type: "string", description: "Package or quantity unit when stated, otherwise an empty string." },
          line_total: { type: "number", description: "Final line total in INR after line-level discount." }
        }
      }
    }
  }
};

export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
export const PROVIDER_TIMEOUT_MS = 45_000;

export async function boundedProviderJson(url, init, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const providerError = await safeProviderError(response);
      const error = new Error(response.status === 409 ? "provider_pending" : (providerError.message || "provider_unavailable"));
      error.status = response.status;
      error.providerErrorCode = providerError.code;
      error.providerContentType = providerError.contentType;
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
    console.error(JSON.stringify(providerFailureDiagnostic(error, controller.signal.aborted, Date.now() - startedAt)));
    if (controller.signal.aborted || error?.name === "AbortError") throw new Error("provider_timeout");
    throw error;
  } finally { clearTimeout(timer); }
}

export function providerFailureDiagnostic(error, timedOut, elapsedMs = 0) {
  const source = error && typeof error === "object" ? error : {};
  const cause = source.cause && typeof source.cause === "object" ? source.cause : {};
  const boundedToken = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "unknown";
  const boundedMediaType = value => typeof value === "string" && /^[a-z0-9.+-]{1,48}\/[a-z0-9.+-]{1,48}$/.test(value) ? value : "unknown";
  const safeMessage = [source.message, cause.message].filter(value => typeof value === "string").join(" ").toLowerCase();
  const transportKind = /(?:certificate|tls|ssl|x509)/.test(safeMessage) ? "tls"
    : /(?:dns|resolve|lookup|name.*service)/.test(safeMessage) ? "dns"
    : /(?:connect|connection refused|network is unreachable)/.test(safeMessage) ? "connect"
    : /(?:invalid.*url|unsupported.*scheme)/.test(safeMessage) ? "request"
    : /(?:fetch|sending request|network)/.test(safeMessage) ? "fetch"
    : "unknown";
  const httpStatus = Number(source.status);
  return {
    event: "sarvam_provider_failure",
    timed_out: timedOut === true,
    http_status: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    error_name: boundedToken(source.name),
    cause_name: boundedToken(cause.name),
    cause_code: boundedToken(cause.code),
    provider_error_code: boundedToken(source.providerErrorCode),
    provider_content_type: boundedMediaType(source.providerContentType),
    transport_kind: transportKind,
    error_message: safeTransportErrorMessage(error),
    elapsed_ms: Number.isInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 60_000 ? elapsedMs : null
  };
}

// Sarvam documents a compact JSON error shape: { error: { code, message } }.
// Retain just that bounded diagnostic for failed HTTP responses. The original
// response is discarded; neither a receipt nor a provider response body is
// otherwise persisted.
async function safeProviderError(response) {
  const contentType = safeProviderContentType(response.headers.get("content-type") || "");
  const defaultError = { code: "unknown", message: "provider_unavailable", contentType };
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 4096) return defaultError;
  try {
    const body = await response.text();
    if (body.length > 4096) return defaultError;
    let candidate;
    try { candidate = JSON.parse(body)?.error; } catch { candidate = null; }
    const code = typeof candidate?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.code)
      ? candidate.code
      : "unknown";
    const message = safeProviderErrorMessage(candidate?.message || body);
    return { code, message: message || defaultError.message, contentType };
  } catch { return defaultError; }
}

function safeProviderContentType(value) {
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]{1,48}\/[a-z0-9.+-]{1,48}$/.test(mediaType) ? mediaType : "unknown";
}

function safeProviderErrorMessage(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<?https?:\/\/[^\s)'\">]+>?/gi, "<url>")
    .replace(/(?:api[-_ ]?(?:subscription[-_ ]?)?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "<redacted-header>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-token>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

// Provider transport errors can be diagnostic, but must never become a path for
// receipt contents, request headers, or credentials to enter persistent logs.
// These errors are produced locally by the HTTP client; retain only a short,
// normalized message after removing URLs and credential-shaped values.
export function safeTransportErrorMessage(error) {
  const message = error && typeof error === "object" && typeof error.message === "string" ? error.message : "";
  const cause = error && typeof error === "object" && error.cause && typeof error.cause === "object" && typeof error.cause.message === "string"
    ? error.cause.message
    : "";
  const normalized = [message, cause].filter(Boolean).join(" | ")
    .replace(/<?https?:\/\/[^\s)'\">]+>?/gi, "<url>")
    .replace(/(?:api[-_ ]?(?:subscription[-_ ]?)?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "<redacted-header>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-token>")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 280) : "unavailable";
}
