# Sanitized receipt parsing Edge Function

This scaffold accepts only a browser-created sanitized derivative. It verifies
the caller's Supabase JWT, delegates household membership and durable quota
enforcement to `reserve_ai_parse`, validates declared page/byte limits and file
magic, and starts an asynchronous Sarvam Document AI Extract job with an inline
receipt allowlist schema. It does not download results, persist documents, or
write purchases. The separate authenticated `sarvam-receipt-result` function
retrieves the bounded Extract result and reduces it to the editable draft;
only the user's later `import_reviewed_purchase` call may persist reviewed
fields.

The server cannot independently prove that a valid sanitized PDF was correctly
redacted. The `sanitized=true` marker and sanitizer version are assertions, not
proof. Security depends on the trusted browser sanitizer rebuilding a fresh
derivative, showing its preview, and refusing cloud processing when uncertain.

The production web client now contains the disabled-by-default first phase of
that flow in `docs/ai-receipt-sanitizer.js`: automatic suggestions come only
from the local parser's already-allowed structured draft fields, while full
extracted text is displayed separately as a local-only reference. It rejects
common identifiers, requires a user-reviewed editable preview, and rebuilds a
new marked one-page PDF. The original PDF bytes and local-only reference are
never used as the request body. The client reuses one opaque idempotency key for
retries of the same in-memory draft. This does not make redaction proof; user
confirmation remains mandatory.

Do not enable either kill switch until the new Extract submit function, result
function and completion-control migration are deployed together and pass the
one-receipt acceptance test. The local parser remains the no-cloud fallback.

Required server-only environment variables:

- `SARVAM_API_KEY` — provider secret; never put it in client code, SQL or logs.
- `AI_PROCESSING_ENABLED` — keep `false` until deployment verification is done.
- `AI_ALLOWED_ORIGIN` — exact production origin, without a trailing path.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — standard
  function environment values. The service role is used only for server-owned
  fixed-state audit updates; never copy or expose it outside the function.

The provider call uses only the current Document AI Extract contract with the
inline schema in `_shared/receipt-contract.mjs`:

- [Extract fields](https://docs.sarvam.ai/api-reference/doc-ai/job/extract)
- [Get job status](https://docs.sarvam.ai/api-reference/doc-ai/job/status)
- [Get job results](https://docs.sarvam.ai/api-reference/doc-ai/job/results)

The database kill switch `private.ai_processing_config.provider_enabled` also
defaults to `false`. Both switches must be enabled before a provider call. The
initial durable allowance is three reservations per authenticated user in a
rolling hour, plus a 100-page monthly household cap. Failed provider attempts
still count so repeated failures cannot bypass the cap.

Never add request-body logging. Observability may contain only fixed error
codes, opaque request/job IDs, page/byte counts, state, latency and charged
units—not filenames, field values, provider bodies, URLs or document hashes.
