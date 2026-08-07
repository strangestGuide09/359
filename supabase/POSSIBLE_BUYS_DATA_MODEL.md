# Possible buys persisted-data design (proposal only)

Status: design review. This document does not authorize or include a migration.

## Conclusion

`purchase_items` is sufficient as an immutable reviewed purchase observation:
it already carries the reviewed name, quantity/unit, prices, personal/shared
allocation, per-item restock choice, use-by date, and its parent purchase date.
It is not sufficient as an automatic identity-learning model. A name is not a
stable product ID; quantity/unit do not always describe package size; there is
no barcode, household alias memory, durable product opt-out, match confidence,
or append-only correction history.

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

Names and barcodes learned only inside one household.

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

Validate barcode values as a conservative 8–14 digit GTIN/UPC/EAN value. Store
them in plain form because exact matching is required, but keep them under
household RLS; never create a cross-household barcode catalogue. A confirmed
barcode match is strong evidence, not permission to merge different package
sizes. Unique confirmed alias values should be scoped to one household and one
package identity, with conflicts requiring review rather than automatic merge.

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
2. Exact confirmed barcode or alias matches may link automatically. A bounded
   canonical-name and exact-package match may be proposed with medium
   confidence. Fuzzy similarity must never auto-merge products.
3. An unseen reviewed name/package creates a household product plus a proposed
   or confirmed reviewed-name alias. Corrections create/switch identities rather
   than rewriting historical observations.
4. Only active links, active purchases, non-personal tracked items, enabled
   products, and non-merchandise grocery rows contribute evidence.
5. Suggestions require at least two distinct purchase dates. Ranking should be
   computed in a view/RPC from recurrence count, recency, interval stability,
   estimated use-by, and link confidence. Do not persist a mutable opaque score;
   return the score, confidence band, and evidence dates so both clients can
   explain it.
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

## Deliberately excluded from the minimum

No global catalogue, retailer history, receipt/PDF reference, extracted text,
free-form correction JSON, embedding, fuzzy vector, inferred demographic data,
or persisted opaque ranking score. Snooze/dismiss state is a later product
feature and should not be conflated with the durable opt-out.

Before implementation, approve the package-unit vocabulary, barcode validation
rules, confidence thresholds, alias-review UX, and whether existing malformed
rows will remain unlinked or receive individually confirmed links.
