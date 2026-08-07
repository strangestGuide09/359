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

The primary flow may use an external document model such as Sarvam Vision, but
the model output is always an untrusted draft. The user must review and edit the
same bounded structured fields already accepted by `import_reviewed_purchase`.
Only that reviewed projection and opaque duplicate hashes may persist in the
Grocery Ledger database.

This changes the current privacy promise: a receipt sent to a remote model is
no longer “processed locally” or “never uploaded.” It requires a separate,
explicit opt-in before each upload (or a clearly revocable preference with a
per-upload reminder), a named processor notice, and an always-available local
parser/manual-entry path. Consent to processing must not imply consent to model
training, longer retention, product learning, or barcode enrichment.

### Recommended Edge Function shape

1. The authenticated client asks a narrow Supabase Edge Function to create a
   processing job. The function verifies the JWT, active household membership,
   consent version, file type/page/size limits, per-user quota, and duplicate
   request idempotency key.
2. The function calls the provider with a server-held API key and returns a
   short-lived provider presigned upload URL plus an opaque client job token.
   The PDF goes directly from the device to the provider; it never enters
   Supabase Storage, Postgres, Edge logs, analytics, or error bodies.
3. A second authenticated function starts/checks the provider job and fetches
   its output. It immediately projects the response into a strict draft schema
   (merchant label, purchase date/category/amount, and bounded item fields),
   rejects unknown fields, and returns the draft without saving provider output.
4. The client presents the editable draft. Saving uses the existing reviewed
   import RPC; canceling or timing out writes no purchase data.

Do not call the provider directly with a long-lived key from JavaScript or the
iPhone binary. Store the provider key only as a Supabase Edge Function secret,
never in Postgres, client configuration, source control, logs, telemetry, crash
reports, URLs, or returned errors. Separate webhook verification secrets from
the API key and rotate both. Prefer authenticated polling initially; if
webhooks are used, verify the callback token and map provider job IDs through a
short-lived server record containing no receipt content.

### Retention and deletion

- Grocery Ledger retention for raw PDF bytes and provider extraction output is
  zero: neither is stored in its database, Storage, caches, or observability.
- Keep presigned URLs and provider job IDs in memory where possible. If an
  asynchronous registry is unavoidable, persist only household/user ID, opaque
  provider job ID, consent version, page count, state, timestamps, and cost
  units; expire it in hours, not days.
- Client drafts remain memory-only. Only reviewed fields persist after Save;
  draft recovery may store only those bounded fields, never PDF bytes or full
  extracted output.
- Provider retention is a separate subprocessor contract. Do not launch until
  its production plan provides acceptable deletion/retention controls. Sarvam's
  general policy currently says inputs/outputs default to 30 days after last
  access and deletion requests may take 30 days; do not call Vision zero-
  retention without a written plan-specific commitment.
- Household deletion removes reviewed data, identities, aliases, links, and any
  remaining job metadata. Provider deletion requests must be tracked separately.

### Consent, abuse, rate, and cost controls

- Before upload show processor, purpose, data sent, retention caveat, and the
  local/manual alternative. Record only consent version, user, timestamp, and
  decision—not receipt content.
- One member may process their receipt, but nothing becomes household-visible
  until that member reviews and saves the structured draft.
- Enforce limits below provider maxima: supported files only, conservative
  bytes/pages, one active job per user, daily household page cap, monthly
  project budget, and idempotency to prevent double billing.
- Count pages before creating a paid job where feasible. Reject encrypted,
  malformed, oversized, or unsupported files locally. Do not retry 4xx errors;
  retry only 429/500/503 with capped exponential backoff, without creating a new
  paid job.
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
