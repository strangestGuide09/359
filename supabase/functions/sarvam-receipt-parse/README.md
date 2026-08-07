# Sanitized receipt parsing Edge Function

This scaffold accepts only a browser-created sanitized derivative. It verifies
the caller's Supabase JWT, delegates household membership and durable quota
enforcement to `reserve_ai_parse`, validates declared page/byte limits and file
magic, and starts an asynchronous Sarvam job. It does not download results,
persist documents, or write purchases. A future completion function must reduce
provider output to the reviewed draft allowlist; only the user's later
`import_reviewed_purchase` call may persist reviewed fields.

The server cannot independently prove that a valid sanitized PDF was correctly
redacted. The `sanitized=true` marker and sanitizer version are assertions, not
proof. Security depends on the trusted browser sanitizer rebuilding a fresh
derivative, showing its preview, and refusing cloud processing when uncertain.

Required server-only environment variables:

- `SARVAM_API_KEY` — provider secret; never put it in client code, SQL or logs.
- `AI_PROCESSING_ENABLED` — keep `false` until deployment verification is done.
- `AI_ALLOWED_ORIGIN` — exact production origin, without a trailing path.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — standard
  function environment values. The service role is used only for server-owned
  fixed-state audit updates; never copy or expose it outside the function.

The database kill switch `private.ai_processing_config.provider_enabled` also
defaults to `false`. Both switches must be enabled before a provider call. The
initial durable allowance is three reservations per authenticated user in a
rolling hour, plus a 100-page monthly household cap. Failed provider attempts
still count so repeated failures cannot bypass the cap.

Never add request-body logging. Observability may contain only fixed error
codes, opaque request/job IDs, page/byte counts, state, latency and charged
units—not filenames, field values, provider bodies, URLs or document hashes.
