function safeReference(error) {
  const code = typeof error?.code === "string" && /^[a-z0-9_-]{1,64}$/i.test(error.code) ? error.code : "";
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? `HTTP ${error.status}` : "";
  const parts = [code, status].filter(Boolean);
  return parts.length ? ` Reference: ${parts.join(" / ")}.` : "";
}

export function classifySignInError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const reference = safeReference(error);

  if (error?.status === 429 || /rate.?limit|too_many_requests/.test(code) || /rate limit|too many requests/.test(message)) {
    return { kind: "rate_limit", message: "Too many sign-in links were requested. Please wait before requesting another one." };
  }
  if (/email_address_invalid|validation_failed/.test(code) || /invalid email|email address.*invalid/.test(message)) {
    return { kind: "invalid_email", message: `That email address was not accepted. Check it for typing mistakes and try again.${reference}` };
  }
  if (/email_provider_disabled|signup_disabled|provider_disabled/.test(code) || /email signups? (?:are|is) disabled|provider.*disabled/.test(message)) {
    return { kind: "configuration", message: `Email sign-in is temporarily unavailable. Please contact the site owner.${reference}` };
  }
  if (/smtp|email_send|send_email/.test(code) || /smtp|error sending|could not send|failed to send|sending confirmation email/.test(message)) {
    return { kind: "delivery", message: `The email service could not send the sign-in link. Try again in a few minutes; if it continues, contact the site owner.${reference}` };
  }
  if (/failed to fetch|network|load failed/.test(message) || error?.name === "TypeError") {
    return { kind: "network", message: "Could not reach the sign-in service. Check your connection and try again." };
  }
  return { kind: "unknown", message: `Could not request a sign-in link. Try again later; if it continues, contact the site owner.${reference}` };
}
