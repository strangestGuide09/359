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

The inaccessible previous database has been replaced. The clean Supabase
bootstrap is deployed and verified, including the two-member contract, RLS,
guarded RPCs, Realtime publication, grant audit, and hosted pgTAP checks. Website
and native clients must still complete their own cross-client production
acceptance; do not treat the verified database foundation as proof of every
client flow.

## Project documents

- `Grocery_Slip_Tracker_Market_Research.docx` is the durable product and design
  reference.
- `Grocery_Change_Log.docx` is the dated record of implementation work,
  verification, defects, and operational decisions.

The corresponding Python builders are the editable sources for these files.

## Visual orientation

See the [Grocery Ledger project map](project-map/README.md) for an easy-to-scan
view of the product purpose, clients, reviewed receipt flow, privacy boundary,
Supabase foundation, optional Sarvam path, current status, and Possible Buys
direction. The companion [Evolution Map](project-map/grocery-ledger-evolution-map.svg)
traces adopted decisions, dropped or deferred ideas, and next milestones.
