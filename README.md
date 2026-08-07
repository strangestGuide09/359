# Grocery Ledger

Grocery Ledger is a private, two-person household ledger for Ekta and Ritesh.
It combines reviewed grocery and household expenses, equal-split balances,
settlements, and transparent restock suggestions.

## Canonical applications

- `docs/` is the production web client for Ekta's laptop. GitHub Pages publishes
  this directory through `.github/workflows/pages.yml`.
- `GroceryLedger/` is the native SwiftUI/SwiftData iPhone app.
- `web/` is a retired Vinext/browser-local prototype. It is retained only as
  implementation history and must not be deployed or used for new product work.

New web features, fixes, and tests belong in `docs/`. Native iPhone work belongs
in `GroceryLedger/` and `GroceryLedgerTests/`.

## Product boundaries

- Each household is limited to exactly two active members.
- Receipt PDFs are selected on the user's device and processed locally.
- Parsing creates an editable, itemized draft. The user reviews the extracted
  merchant, date, total, and purchased items before saving.
- Reviewed ledger fields and purchased items may sync. Raw PDFs, extracted
  receipt text, addresses, payment methods, card/bank/UPI details, and payment
  references must not be stored or synced.
- Purchased items provide the evidence used by restock suggestions. Removing
  raw-PDF persistence must never remove PDF import or itemized review.

## Database status

The previous hosted database is no longer accessible. Treat the next database
as a clean deployment: review the schema, enforce the two-member limit, add
integration tests, and then create a new free-tier backend. Do not assume the
old migration history exists in the replacement database.

The SQL files in `supabase/` document the previous Supabase implementation.
They are reference material until a clean bootstrap migration is prepared and
verified. Do not run the historical migrations blindly against a new project.

## Project documents

- `Grocery_Slip_Tracker_Market_Research.docx` is the durable product and design
  reference.
- `Grocery_Change_Log.docx` is the dated record of implementation work,
  verification, defects, and operational decisions.

The corresponding Python builders are the editable sources for these files.
