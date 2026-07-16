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
