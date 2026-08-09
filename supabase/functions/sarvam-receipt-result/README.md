# Sarvam receipt result completion

This authenticated Edge Function accepts only the opaque Grocery Ledger job ID
and household ID. The service-role-only `claim_ai_parse_completion` RPC binds
that job to the verified requesting user and active household before returning
its provider job ID. Durable poll counts, minimum intervals, the six-hour TTL,
the environment kill switch and the database kill switch all apply.

The function polls Sarvam's current Document AI status endpoint and retrieves
the current Extract result only for that bound job. Provider responses are read
with strict byte limits. Only the allowlisted receipt draft projection is
returned; annotations, sources, filenames, raw provider bodies and unreviewed
fields are neither returned nor stored. A completed job may be fetched again
within its shortened TTL, making completion idempotent without persisting the
unreviewed draft.

Current provider contracts used by this pair of functions:

- [Extract fields](https://docs.sarvam.ai/api-reference/doc-ai/job/extract)
- [Get job status](https://docs.sarvam.ai/api-reference/doc-ai/job/status)
- [Get job results](https://docs.sarvam.ai/api-reference/doc-ai/job/results)

Keep `AI_PROCESSING_ENABLED=false` and database `provider_enabled=false` until
both functions and the incremental migration have been deployed and a single
sanitized synthetic/manual receipt is approved for a controlled test. Never log
request or provider bodies.

Client-visible completion codes are fixed to `pending`, `completed`,
`processing_disabled`, `job_not_found`, `job_expired`, `completion_timeout`,
`submission_retry_exhausted`, `provider_failed`, `provider_unavailable`, and
`invalid_provider_result`. Provider messages, filenames, annotations and URLs
must never be copied into an error response.

## Deployment prerequisites (do not run until approved)

1. Run `supabase/migrations/20260808000000_ai_parse_completion.sql`, followed by
   `supabase/migrations/20260809010000_ai_submission_claim.sql`, in the hosted
   SQL editor. Then run `supabase/tests/004_ai_parse_completion.sql` and
   `supabase/tests/005_ai_submission_claim.sql`. The tests are transactional and
   must finish with ten and eight `ok` rows respectively, followed by rollback.
2. Deploy `sarvam-receipt-parse` and `sarvam-receipt-result` together from the
   repository with the Supabase CLI so the shared receipt contract is bundled.
   Both functions use custom current-session validation, so deploy them with
   gateway JWT verification disabled (`--no-verify-jwt`).
3. No new secret is required. Both functions use the existing server-only
   `SARVAM_API_KEY`, exact `AI_ALLOWED_ORIGIN`, standard Supabase function
   variables, and `AI_PROCESSING_ENABLED`.
4. Leave `AI_PROCESSING_ENABLED=false` and
   `private.ai_processing_config.provider_enabled=false` after deployment.
   Enable them only for the bounded acceptance window, then disable them again.
5. Confirm the Sarvam account's Document AI entitlement and current retention
   or deletion terms for redacted derivatives. The integration does not call a
   provider-side deletion endpoint.

The first real acceptance test must use one manually reviewed redacted
derivative with no personal/payment data. Confirm: submit returns one opaque job
ID; pending uses fixed status only; completion offers an editable local draft;
declining it leaves the existing draft unchanged; no purchase is saved until
the normal review Save action; Edge logs and the private job row contain no
document or result content. Also verify an unrelated household session receives
only `job_not_found` for that opaque job ID.
