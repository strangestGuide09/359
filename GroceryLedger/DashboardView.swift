import SwiftUI
import SwiftData

struct DashboardView: View {
    @Query(sort: \Purchase.purchasedAt, order: .reverse) private var purchases: [Purchase]
    @Query(sort: \Settlement.settledAt, order: .reverse) private var settlements: [Settlement]

    private var summary: BalanceSummary { LedgerEngine.summary(purchases: purchases, settlements: settlements) }
    private var possibleBuys: [RestockSuggestion] { LedgerEngine.possibleBuys(from: purchases) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(summary.settlementMessage)
                            .font(.headline)
                        Text("Shared grocery ledger for Ekta and Ritesh")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
                Section("Possible buys") {
                    if possibleBuys.isEmpty {
                        Label(emptySuggestionMessage, systemImage: "cart")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(possibleBuys) { item in
                            VStack(alignment: .leading, spacing: 3) {
                                Label(item.name, systemImage: "cart.badge.plus")
                                Text(suggestionDetail(item))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("Recent purchases") {
                    if purchases.isEmpty {
                        Text("Import a PDF invoice from the Purchases tab to begin.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(purchases.prefix(5), id: \.id) { purchase in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(purchase.merchant).font(.headline)
                                Text(purchase.purchasedAt, format: .dateTime.day().month().year())
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(LedgerEngine.sharedTotal(for: purchase), format: .currency(code: "INR"))
                        }
                    }
                }
            }
            .navigationTitle("Grocery Ledger")
        }
    }

    private var emptySuggestionMessage: String {
        if purchases.count < 2 {
            return "Add another reviewed invoice before the app can look for a repeat purchase."
        }
        return "No matching repeat product across the \(purchases.count) saved invoices yet. Import the remaining PDFs to build a pattern."
    }

    private func suggestionDetail(_ item: RestockSuggestion) -> String {
        if item.needsHistoryCleanup {
            return "Duplicate same-day imports detected — clean up history before forecasting"
        }
        if item.usesEstimatedUseBy {
            return "Estimated to run out around \(item.estimatedNextBuy.formatted(date: .abbreviated, time: .omitted)) — update this if your usage changes"
        }
        if item.usualIntervalDays > 0 {
            return "Seen \(item.purchaseCount) times • usual interval ~\(item.usualIntervalDays) days"
        }
        return "Seen \(item.purchaseCount) times in imported receipts — confirm if you want it on your list"
    }
}
