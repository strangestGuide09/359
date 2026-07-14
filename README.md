# Grocery Ledger

## Live database migrations

Run the existing migrations only once, in this order, from the Supabase SQL
Editor:

1. `supabase/add-local-pdf-imports.sql` (if it has not already been applied)
2. `supabase/multi-household-lifecycle.sql`

Do **not** rerun `supabase/schema.sql` against the already-created project. It
creates the original RLS policies and is intentionally not repeatable. The
multi-household migration is idempotent and adds the staged web flow’s
Owner/Admin/Member permissions, 30-day recovery archive, and secure manager-
issued invites.

The web app stores reviewed ledger entries and duplicate fingerprints only. It
does not store raw PDFs, receipt text, addresses, payment modes, card/bank/UPI
details, or payment references.
