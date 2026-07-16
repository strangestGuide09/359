import assert from "node:assert/strict";
import test from "node:test";
import { classifySignInError } from "../auth-errors.js";

test("only actual rate-limit classifications trigger the cooldown kind", () => {
  assert.equal(classifySignInError({ status: 429, message: "Too many requests" }).kind, "rate_limit");
  assert.equal(classifySignInError({ code: "over_email_send_rate_limit" }).kind, "rate_limit");
  assert.notEqual(classifySignInError({ status: 500, message: "Error sending confirmation email" }).kind, "rate_limit");
});

test("delivery, configuration, validation, and network failures are actionable", () => {
  assert.equal(classifySignInError({ status: 500, message: "Error sending confirmation email" }).kind, "delivery");
  assert.equal(classifySignInError({ code: "email_provider_disabled", status: 400 }).kind, "configuration");
  assert.equal(classifySignInError({ code: "email_address_invalid", status: 422 }).kind, "invalid_email");
  assert.equal(classifySignInError({ name: "TypeError", message: "Failed to fetch" }).kind, "network");
});

test("fallback exposes only sanitized code and status references", () => {
  const safe = classifySignInError({ code: "unexpected_failure", status: 503, message: "database host secret.internal stack trace" });
  assert.equal(safe.kind, "unknown");
  assert.match(safe.message, /Reference: unexpected_failure \/ HTTP 503/);
  assert.doesNotMatch(safe.message, /secret\.internal|stack trace|database host/);

  const unsafe = classifySignInError({ code: "token=super-secret", status: 599, message: "private response body" });
  assert.doesNotMatch(unsafe.message, /token=|super-secret|private response body/);
  assert.match(unsafe.message, /HTTP 599/);
});
