# Possible buys persisted-data design (proposal only)

Status: design review. This document does not authorize or include a migration.

## Conclusion

`purchase_items` is sufficient as an immutable reviewed purchase observation:
it already carries the reviewed name, quantity/unit, prices, personal/shared
allocation, per-item restock choice, use-by date, and its parent purchase date.
It is not sufficient as an automatic identity-learning model. A name is not a
stable product ID; quantity/unit do not always describe package size; there is
no household alias memory, durable product opt-out, match confidence, or
append-only correction history. Barcode is optional corroborating evidence,
not a dependency or the primary identity path.

Keep `purchase_items` as the evidence snapshot and add household-scoped identity
tables. Do not overwrite old reviewed item names merely because the identity
model learns a better canonical name.

## Minimum additive model

### `household_products`

One household-private product identity and package variant.

- `id uuid primary key`
- `household_id uuid not null`
- `display_name text not null` (trimmed, bounded reviewed label)
- `package_quantity numeric null`
- `package_unit text null` (small validated vocabulary such as g, kg, ml, l,
  count)
- `suggestions_enabled boolean not null default true` (durable household opt-out)
- `created_by uuid`, `created_at`, `updated_at`

Package amount/unit are part of identity: milk 500 ml and milk 1 l must remain
separate products. Do not impose uniqueness on display name alone.

### `household_product_aliases`

Reviewed names learned inside one household, with optional barcode aliases.

- `id uuid primary key`
- `household_id uuid not null`
- `product_id uuid not null`
- `alias_kind text` constrained to `reviewed_name` or `barcode`
- `display_value text not null` (bounded; digits only for barcode)
- `normalized_value text not null`
- `status text` constrained to `proposed`, `confirmed`, `rejected`, or
  `deprecated`
- `confidence numeric(4,3)` constrained from 0 through 1
- `created_by uuid`, `created_at`, `reviewed_by uuid null`, `reviewed_at null`

Most receipt imports will have no barcode. When a user or trusted structured
source supplies one, validate it as a conservative 8–14 digit GTIN/UPC/EAN
value. Store it in plain form because exact matching is required, but keep it
under household RLS; never create a cross-household barcode catalogue. A
confirmed barcode match is strong evidence, not permission to merge different
package sizes. Unique confirmed aliases should be scoped to one household and
one package identity, with conflicts requiring review rather than automatic
merge.

### `purchase_item_product_links`

Append-only identity decisions connecting observations to products.

- `id uuid primary key`
- `household_id uuid not null`
- `purchase_item_id uuid not null`
- `product_id uuid not null`
- `match_method text` constrained to `barcode`, `confirmed_alias`,
  `canonical_exact`, `new_product`, or `manual_correction`
- `confidence numeric(4,3)` constrained from 0 through 1
- `status text` constrained to `active`, `superseded`, or `rejected`
- `created_by uuid`, `created_at`, `superseded_by uuid null`,
  `superseded_at null`

A partial unique index permits only one active link per purchase item. A
correction appends a new link and supersedes the previous link in one
transaction; it never destroys the former decision. Alias status changes retain
the old row as deprecated/rejected, providing structured correction history
without an unrestricted before/after text or JSON field.

## Learning and ranking contract

1. The reviewed item remains the source observation. Raw PDF bytes, OCR text,
   parser rows, receipt snippets, addresses, and payment metadata are never
   accepted by these tables or RPCs.
2. A confirmed reviewed-name alias plus exact package may link automatically.
   Barcode, when present, strengthens the match. A bounded canonical-name and
   exact-package match may be proposed with medium confidence. Fuzzy similarity
   must never auto-merge products.
3. An unseen reviewed name/package creates a household product plus a proposed
   or confirmed reviewed-name alias. Corrections create/switch identities rather
   than rewriting historical observations.
4. Only active links, active purchases, non-personal tracked items, enabled
   products, and non-merchandise grocery rows contribute evidence.
5. Suggestions require at least two distinct purchase dates. Ranking should be
   computed in a view/RPC from recurrence count, recency, interval stability,
   and link confidence. Do not persist a mutable opaque score; return the score,
   confidence band, and evidence dates so both clients can explain it.
6. Item-level `purchase_items.is_tracked_for_restock = false` excludes that
   observation. Product-level `suggestions_enabled = false` is the durable
   household opt-out. Re-enabling does not rewrite historical item choices.

## Privacy, authorization, and lifecycle

- Every new row carries `household_id`; RLS uses the existing household-member
  boundary for reads and active-member boundary for writes.
- Both household members may review matches and opt out; there is no admin role.
- Foreign keys/triggers must verify the product, alias, link, purchase item, and
  actor all belong to the same household. Client-supplied confidence cannot be
  trusted without server-side method bounds.
- Realtime is unnecessary for aliases/corrections in the minimum release unless
  clients expose an identity-management screen. Suggestions can refresh after
  purchases or explicit corrections.
- All three tables cascade with permanent household deletion. No global product
  or behavioral profile survives household deletion.

## AI-assisted receipt processing boundary

The primary flow may use an external document model such as Sarvam Vision only
after mandatory local sanitization. The original PDF/image and all original or
unredacted extracted text stay transiently on the client and are never uploaded
or stored. The remote model receives only a newly constructed, already-redacted
derivative. Its output remains an untrusted draft: the user must review and edit
the same bounded structured fields accepted by `import_reviewed_purchase`. Only
that reviewed projection and opaque duplicate hashes may persist.

This changes the current privacy promise: a receipt sent to a remote model is
no longer “processed locally” or “never uploaded.” It requires a separate,
explicit opt-in before each upload (or a clearly revocable preference with a
per-upload reminder), a preview of exactly what the sanitized derivative
contains, a named processor notice, and an always-available local parser/manual-
entry path. Consent to processing must not imply consent to model training,
longer retention, product learning, or barcode enrichment.

### Mandatory local sanitization

The client first parses locally in memory, applies an allowlist, and constructs
a new derivative document from allowed values. It must not upload the original
page with visual black boxes or PDF annotations: underlying text, layers,
metadata, thumbnails, attachments, QR codes, and cropped pixels can remain
recoverable. The derivative should be a fresh minimal PDF/image/structured
document containing only:

- coarse merchant label, purchase date, category, total, and currency;
- candidate item name, quantity, unit, unit price, and line total; and
- optional printed batch/use-by value only when the user explicitly leaves it
  visible for remote extraction.

Remove names of people, email/phone, delivery/billing address, order/invoice and
customer/loyalty identifiers, payment method, card/UPI/bank data, tax identifiers,
delivery instructions, location, receipt-level barcode/QR content, hidden PDF
objects, filenames, and device metadata. Product barcode remains optional and
must be separately confirmed; it is not copied automatically from an arbitrary
receipt QR/barcode.

Before upload, show a local preview and require confirmation. If local parsing
cannot confidently isolate the allowlisted fields or rebuild a derivative with
no original pixels/text/metadata, disable cloud processing for that document and
continue with local/manual review. Sanitizer output and redaction decisions are
security-sensitive code and require adversarial fixture tests.

### Recommended Edge Function shape

1. After local preview/consent, the client sends the newly rebuilt sanitized PDF
   to a narrow Supabase Edge Function with sanitizer version, page count,
   household ID, and idempotency key. It never sends the original document or
   unredacted extraction. The function verifies the JWT, active household
   membership, origin, PDF signature/sanitizer marker/passive features,
   type/size/pages, quotas, budget, and idempotency before any provider call.
2. The function keeps the derivative only in request memory, creates the
   provider job with its server-held key, and uploads the derivative through the
   provider's short-lived presigned URL. Original bytes and unredacted text
   never enter the Edge Function or provider; derivative bytes never enter
   Supabase Storage/Postgres, logs, analytics, or error bodies.
3. A second authenticated function starts/checks the provider job and fetches
   its output with strict response byte/time limits. It immediately projects the
   response into a strict draft schema (merchant label, purchase date/category/
   amount, and bounded item fields), rejects unknown or oversized fields, and
   returns the draft without saving provider output.
4. The client presents the editable draft. Saving uses the existing reviewed
   import RPC; canceling or timing out writes no purchase data.

Do not call the provider directly with a long-lived key from JavaScript or the
iPhone binary. Store the provider key only as a Supabase Edge Function secret,
never in Postgres, client configuration, source control, logs, telemetry, crash
reports, URLs, or returned errors. Separate webhook verification secrets from
the API key and rotate both. Prefer authenticated polling initially; if
webhooks are used, verify the callback token and map provider job IDs through a
short-lived server record containing no receipt content. The Edge Function must
disable request/response body capture, avoid interpolating provider errors, and
emit fixed public error codes plus an opaque request ID only.

### Retention and deletion

- Grocery Ledger retention for originals, unredacted extracted text, sanitized
  derivative bytes, and provider extraction output is zero: none is stored in
  its database, Storage, caches, queues, logs, traces, crash reports, or analytics.
- Keep presigned URLs and provider job IDs in memory where possible. If an
  asynchronous registry is unavoidable, persist only household/user ID, opaque
  provider job ID, consent version, page count, state, timestamps, and cost
  units; expire it in hours, not days.
- Original/unredacted client material is memory-only and wiped on cancel,
  completion, timeout, navigation, or app background termination. The sanitized
  derivative is discarded immediately after upload. Draft recovery may store
  only user-reviewed bounded fields, never original/derivative bytes or full
  extracted output.
- Provider retention is a separate subprocessor contract. Do not launch until
  its production plan provides acceptable deletion/retention controls. Sarvam's
  general policy currently says inputs/outputs default to 30 days after last
  access and deletion requests may take 30 days; do not call Vision zero-
  retention without a written plan-specific commitment.
- On completion, cancellation, or timeout, call a provider deletion endpoint if
  available and expire any presigned URLs. Household deletion removes reviewed
  data, identities, aliases, links, consent references, and remaining job
  metadata. Provider deletion requests must be tracked separately by opaque ID.

### Content-free audit record

If an audit table is approved, permit only: household/user ID, consent-policy and
sanitizer versions, derivative MIME/page/byte counts, provider name, opaque job
ID, state, charged units, fixed error code, and created/expires/deleted times.
Apply household RLS, active-member writes, bounded enums/counts, and automatic
job-row expiry in hours. Never store original or derivative filenames, field
values, merchant/item text, raw/provider responses, presigned URLs, IP/device
fingerprints, or receipt hashes in this operational record. Keep the existing
household-scoped duplicate hashes only in `invoice_imports` after reviewed save.

### Consent, abuse, rate, and cost controls

- Before upload show processor, purpose, data sent, retention caveat, and the
  local/manual alternative. Record only consent version, user, timestamp, and
  decision—not receipt content.
- One member may process their receipt, but nothing becomes household-visible
  until that member reviews and saves the structured draft.
- Enforce limits below provider maxima on both client and Edge control plane:
  allowlisted MIME and magic bytes, conservative derivative bytes/pages/page
  dimensions, decompression ratio, field/output lengths, one active job per
  user, daily household page cap, monthly project budget, and idempotency.
- Count pages before creating a paid job where feasible. Reject encrypted,
  malformed, oversized, or unsupported files locally. Do not retry 4xx errors;
  retry only 429/500/503 with capped exponential backoff, without creating a new
  paid job.
- Reject archives, active content, attachments, encrypted PDFs, malformed page
  trees, excessive object/image counts, and derivatives lacking the current
  sanitizer marker/version. Treat the marker as routing metadata, not proof of
  sanitization; the trusted client construction and preview remain essential.
- Track only aggregate page count, provider, state, latency, and charged units.
  Never log filenames, merchant/item text, extracted fields, presigned URLs,
  provider output, or document hashes usable outside the household.
- Provide a hard kill switch and budget alert. Current Sarvam documentation
  lists ₹0.50/page, a 10-page job limit, and 10 requests/minute, but recheck all
  three before implementation.

## Product cadence is not batch expiry

Possible buys predicts household product-level repurchase cadence from multiple
reviewed purchase dates. Cadence belongs to `household_products` and is derived
from linked observations; it is not a food-safety claim.

`purchase_items.estimated_use_by` is optional, reviewed information for that
specific purchased batch. It may inform a one-off reminder, but must not train
or overwrite product cadence, become a canonical shelf life, or carry forward
to another batch. The model must not invent expiry dates. Any future expiry
extraction needs a separately reviewed field with explicit batch semantics.

## Deliberately excluded from the minimum

No global catalogue, retailer history, receipt/PDF reference, extracted text,
free-form correction JSON, embedding, fuzzy vector, inferred demographic data,
or persisted opaque ranking score. Snooze/dismiss state is a later product
feature and should not be conflated with the durable opt-out.

Before implementation, approve the remote-processing privacy-policy change,
provider retention/deletion contract, consent UX, monthly budget, package-unit
vocabulary, confidence thresholds, alias-review UX, optional barcode rules, and
whether existing malformed rows remain unlinked or receive confirmed links.

## Provider facts checked for this review

- Sarvam Document Digitization uses asynchronous jobs and presigned upload and
  download URLs; its documented limit is 10 pages per job.
- Published pricing is ₹0.50/page and the documented Document Intelligence rate
  limit is 10 requests/minute.
- Sarvam's public privacy policy says product inputs/uploads/outputs are
  collected, content retention defaults to 30 days after last access, model
  training is opt-in, and requested deletion is completed within 30 days.

Reverify these facts and obtain plan-specific commitments before selecting a
provider; public documentation can change.

Official references checked 2026-08-07:

- https://docs.sarvam.ai/api/api-guides-tutorials/document-digitization/overview
- https://docs.sarvam.ai/api-reference/document-intelligence/get-upload-links
- https://docs.sarvam.ai/api/getting-started/pricing
- https://docs.sarvam.ai/api/getting-started/ratelimits
- https://www.sarvam.ai/privacy-policy
