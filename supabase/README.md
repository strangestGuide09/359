# Grocery Ledger database

`migrations/20260715000000_clean_bootstrap.sql` is the only bootstrap for the
replacement database. Apply it once to the approved empty hosted project
(`yhcucqzikcqrlhgjwywe`) in the Supabase Dashboard SQL Editor; do not run the
older top-level SQL files first. Those files describe the inaccessible
historical deployment and remain reference material only.

The database is deliberately provider-portable PostgreSQL except for Supabase
Auth (`auth.users`, `auth.uid()`), PostgREST grants, and Realtime publication.
Supabase remains the lowest-change replacement because the production web
client already uses its Auth, Data API, RPC, and Realtime contracts. Moving to
another provider would require replacing those four integration points in both
clients and would not improve the local-PDF privacy boundary.

## Synchronization contract

- Synced: household membership, reviewed purchase headers, reviewed item names
  and quantities/prices, restock flags/dates, settlements, opaque import hashes,
  lifecycle state, and minimal audit events.
- Device-only and ephemeral: PDF bytes and extracted/OCR receipt text.
- Never accepted by the itemized import RPC: unknown JSON keys. This prevents a
  client from accidentally attaching raw extraction output to a reviewed item.
- Duplicate detection and the reviewed ledger write happen in one transaction.
- Every membership insertion path is guarded by a serialized two-member trigger;
  the invite RPC also refuses to issue an invite after the household is full.
- An account may belong to only one non-archived household in the first release.
- Roles are deliberately limited to `owner` and `partner`; there is no admin
  promotion workflow.
- Shared expenses and settlements require both people to have joined. A personal
  expense may be recorded before the partner joins.
- `household_members.display_name` stores a trimmed 1–80 character safe name
  and is readable only through the existing household-member RLS policy.
- A signed-in uploader may select either active household member as
  `purchases.paid_by`. For reviewed PDF imports, `invoice_imports.imported_by`
  always remains the authenticated uploader, independently of the selected payer.

## Proposed automatic Possible buys identity model

The design-only recommendation is documented in
`POSSIBLE_BUYS_DATA_MODEL.md`. The current `purchase_items` table remains the
reviewed observation record but is not, by itself, a safe product-identity and
learning model. The minimum recommendation is three additive household-private
tables for package-specific products, primarily reviewed-name aliases with
optional barcode corroboration, and append-only purchase-item identity
links/corrections. Ranking is derived from evidence rather than stored as an
opaque score. The note also mandates local allowlist sanitization and a rebuilt
derivative before any consent-gated Edge Function/provider flow: originals and
unredacted extracted text never leave the client, while provider keys remain
server-only. It separates product repurchase cadence from batch-specific use-by
dates. No migration or remote-processing integration has been created or approved.

## Live incremental migration — member names and selected payer

After the clean bootstrap is already live, run exactly
`migrations/20260716000000_member_names_and_selected_payer.sql` once in the
Supabase SQL Editor. It is transaction-wrapped. Then run
`tests/002_member_names_and_selected_payer.sql`; all 12 assertions must pass and
its synthetic data will roll back.

Existing memberships receive neutral `Household owner` / `Household partner`
placeholders during migration. Each signed-in person should replace their own
placeholder with Ritesh or Ekta through `set_member_display_name(text)` (or the
client's one-time name UI). New onboarding should pass the signup name directly
to `create_household(text,text)` or `join_household(uuid,text)`. Never derive or
expose a display name from an email address or Auth metadata.

The replacement hosted project has been created and the project owner approved
direct Dashboard validation and deployment on 2026-07-15. The public client
credentials are now configured in the production web client after the bootstrap
and checks below passed.

## Hosted validation record — 2026-07-15

- The clean bootstrap executed inside an explicit transaction successfully.
- All 20 pgTAP contract assertions passed and the synthetic test data rolled back.
- `supabase_realtime` contains exactly `household_members`, `purchase_items`,
  `purchases`, and `settlements`.
- Auth uses the exact Site URL and redirect URL
  `https://strangestguide09.github.io/359/`; Email authentication is enabled.
- Custom SMTP was saved on 2026-07-15 using Brevo at
  `smtp-relay.brevo.com:587`, with the verified free Gmail-address sender name
  `Grocery Ledger` and a 60-second minimum send interval. No SMTP credential is
  stored in this repository.
- Brevo reports the expected DKIM, DMARC, and free-address deliverability
  warnings. Successful Magic Link delivery to both users remains a live
  acceptance-test requirement.
- Security Advisor reported zero errors, nine expected warnings for the
  authenticated Grocery Ledger `SECURITY DEFINER` RPCs, and one informational
  suggestion.
- The RPC audit found the nine app functions with anonymous execution denied
  and authenticated execution allowed. Supabase's `rls_auto_enable()` helper
  was also `SECURITY DEFINER`, but execution was denied to both anonymous and
  authenticated clients and it is not part of the application API.

These warnings are expected only while their grants remain exactly as audited.
Any future anonymous execute grant, service-role client use, missing RLS policy,
additional Realtime table, or new Advisor error requires investigation.

## Validation and deployment order

1. In Table Editor, confirm the replacement project has no Grocery Ledger
   tables from an earlier attempt.
2. Open a new SQL Editor query and execute the clean bootstrap inside an
   explicit transaction (`begin;` before the file and `commit;` after it).
3. Execute `tests/001_clean_bootstrap_contract.sql` in a separate SQL Editor
   query. It is transaction-wrapped and rolls back its synthetic users/data.
4. Require all 20 pgTAP assertions to pass. If either query fails, stop and
   diagnose the error before changing or rerunning parts of the schema.
5. Review Security Advisor and resolve every unexpected security finding.
6. Confirm the expected tables and Realtime publication, then configure the
   hosted Auth Site URL and exact redirect allow-list.
7. Hand the Project URL and `sb_publishable_...` key to the web workstream.

This Dashboard-first path was the explicit owner-approved decision and skipped
the unavailable local Supabase CLI/container stack. Keep every future schema
change represented by a committed migration before applying it so the hosted
schema remains reproducible.

Never pass a database password, `sb_secret_...` key, `service_role` key, CLI
access token, SMTP key/password, or password-bearing connection string through
client code or chat.

## Restock history audit and legacy flags

Open `support/restock_history_audit.sql`, copy the entire file into Supabase SQL
Editor, and press **Run** once. It contains one read-only query and returns one
result only. Do not run only a selected fragment. Each result row names the
reviewed item, lists all dates and qualifying tracked dates, states whether any
appearance is personal or a fee/charge, gives `possible_buys_eligible`, and
explains the result in `eligibility_reason`.
Multiple receipts on the same date provide only one date of restock history, so
they do not establish a buying interval by themselves.

The production website does not call a restock RPC. It selects active
`purchases` with embedded `purchase_items` and computes Possible buys locally.
An item is eligible only when its purchase category is Groceries, it is
non-personal and tracked, it is not a delivery/handling/platform/service charge,
fee, tax, GST, subtotal, total, discount, or savings row, and its website-
compatible canonical key appears on at least two distinct `purchased_on` dates.
Rows saying `untracked`, `personal item excluded`, `delivery/fee/tax excluded`,
`non-grocery purchase excluded`, or `needs a tracked purchase on another date`
are diagnostics, not suggestions.
Only `possible_buys_eligible = true` with reason `eligible now` satisfies the
feature rule. The audit mirrors the website's bounded normalization for leading
line/SKU numbers, known merchant labels, units, pack formatting, and its short
approved brand-prefix list. It preserves product sizes and does not use fuzzy
matching, so similarly named but distinct products are not merged merely by
similarity. A signed-out client or the publishable key alone cannot audit
household rows because RLS correctly hides them; use the Dashboard SQL Editor.
Do not share the result if reviewed item names are sensitive.

There is no reliable database marker distinguishing the former website default
(`is_tracked_for_restock = false`) from a user's explicit opt-out. `created_at`
is not sufficient evidence, so there is intentionally no date-based or blanket
backfill. The simplified report intentionally omits item UUIDs and performs no
update. If the user later approves a specific backfill, obtain the exact
`purchase_items.id` values in a separate, explicitly scoped review, then place
only those IDs into `support/manual_restock_backfill.sql`. That transaction
rejects an empty list, rejects missing or personal IDs, and updates only still-
untracked non-personal items. A mistakenly confirmed UUID would override that
item's prior opt-out and must therefore be reviewed carefully.

### Repairing historic malformed reviewed items

The database deliberately has no raw PDF or extracted receipt text from which
to reconstruct a malformed line. A parser-looking row is therefore evidence
for review, not evidence of the correct product name, quantity, or price.

1. Rerun the read-only report. Excluded delivery/fee/tax rows require no urgent
   database change because they cannot qualify even if their old tracked flag
   is true.
2. Compare each malformed merchandise row with a trusted source still held by
   the user, such as the original local invoice, merchant order history, or a
   paper receipt. Do not infer corrected fields from the malformed text alone.
3. For a confirmed non-merchandise row, the safest future repair is an exact-ID
   update setting only `is_tracked_for_restock = false`; do not delete it because
   deletion could change itemized shared totals and historical context.
4. For a confirmed merchandise row, prepare an exact-ID, expected-old-value
   transaction containing only user-confirmed replacements. Review the proposed
   before/after rows and transaction row count before committing it.
5. If no trusted source remains, leave the row unchanged and excluded/unmatched.
   Never run a date-, merchant-, name-pattern-, or household-wide cleanup.

No repair SQL is supplied by this audit because its output intentionally omits
item UUIDs. Create a separately reviewed repair script only after the user has
identified the exact rows and supplied the trustworthy corrected values.
