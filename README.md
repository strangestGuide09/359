# Grocery Ledger

Grocery Ledger is a private ledger for one two-person household. It turns
reviewed grocery and household purchases into shared balances, payment history,
and transparent Possible Buys suggestions.

Each household is limited to exactly two active members: Owner and Partner.

## Applications

- `docs/` is the production web client and GitHub Pages static source.
- `GroceryLedger/` is the native SwiftUI/SwiftData iPhone app.
- `web/` is a retired prototype and is not a production surface.

## Run and test the web client

Serve the static client from the repository root:

```sh
python3 -m http.server 4173 --directory docs
```

Then open `http://localhost:4173`. Run the web tests with a supported Node.js
installation:

```sh
node --test docs/tests/*.test.mjs
```

Browser-geometry tests require their Playwright browser executable; when it is
not installed, those tests report as skipped rather than passed.

## Privacy boundary

Receipt PDFs and extracted receipt text stay local and transient. Import creates
an editable itemized draft and never saves automatically. Only deliberately
reviewed structured fields and opaque duplicate fingerprints may persist or
sync. Original receipts, raw extracted text, addresses, and card, bank, UPI, or
payment-reference details must not be uploaded or stored.

## Repository scope

Supabase provides the two-seat household database, Auth, RLS, guarded RPCs, and
Realtime. The checked-in migration and test sources define that contract; client
features still require their own verification before production claims.

Detailed product references, acceptance notes, TODOs, changelogs, generated Word
documents, and their builders are maintained locally and intentionally excluded
from Git. This README carries only the public high-level project orientation.

The tracked [project map](project-map/README.md) provides a visual overview of the
clients, privacy boundary, platform foundation, and roadmap.
