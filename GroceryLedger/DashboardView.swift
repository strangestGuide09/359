import SwiftUI
import SwiftData

struct DashboardView: View {
    @Query(sort: \Purchase.purchasedAt, order: .reverse) private var purchases: [Purchase]
    @Query(sort: \Settlement.settledAt, order: .reverse) private var settlements: [Settlement]

    private var summary: BalanceSummary { LedgerEngine.summary(purchases: purchases, settlements: settlements) }
    private var possibleBuys: [RestockSuggestion] { LedgerEngine.possibleBuys(from: purchases) }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    masthead
                    balanceCard
                    restockCard
                    recentCard
                    privacyCard
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
            .background(GroceryBrand.cream)
            .navigationTitle("Grocery Ledger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(GroceryBrand.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .tint(GroceryBrand.pine)
    }

    private var masthead: some View {
        VStack(alignment: .leading, spacing: 8) {
            BrandEyebrow(text: "Shared home ledger")
            Text("Split the bill.\nSee what’s next.")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .tracking(-1.3)
                .foregroundStyle(GroceryBrand.ink)
            Text("A private ledger for Ekta and Ritesh, with gentle restock cues.")
                .font(.subheadline)
                .foregroundStyle(GroceryBrand.muted)
        }
        .padding(.top, 18)
    }

    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("TODAY’S BALANCE")
                .font(.caption2.weight(.bold))
                .tracking(1.3)
                .foregroundStyle(Color.white.opacity(0.72))
            Text(summary.settlementMessage)
                .font(.title2.bold())
                .foregroundStyle(.white)
            HStack(spacing: 7) {
                Image(systemName: "person.2.fill")
                Text("2 members · equal split")
            }
            .font(.caption)
            .foregroundStyle(Color.white.opacity(0.72))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(GroceryBrand.pine)
                .shadow(color: GroceryBrand.warmShadow, radius: 0, x: 6, y: 6)
        }
        .padding(.bottom, 6)
    }

    private var restockCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                BrandEyebrow(text: "Restock")
                Text("Possible buys").font(.title2.bold())
            }
            if possibleBuys.isEmpty {
                BrandEmptyState(icon: "cart", title: "Nothing suggested yet", message: emptySuggestionMessage)
            } else {
                ForEach(possibleBuys) { item in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "cart.badge.plus")
                            .foregroundStyle(GroceryBrand.orange)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.name).font(.headline)
                            Text(suggestionDetail(item))
                                .font(.caption)
                                .foregroundStyle(GroceryBrand.muted)
                        }
                        Spacer()
                    }
                    if item.id != possibleBuys.last?.id { Divider().overlay(GroceryBrand.line) }
                }
            }
        }
        .brandCard(accent: GroceryBrand.orange)
    }

    private var recentCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    BrandEyebrow(text: "Activity")
                    Text("Recent purchases").font(.title2.bold())
                }
                Spacer()
                Text("\(purchases.count) saved")
                    .font(.caption)
                    .foregroundStyle(GroceryBrand.muted)
            }
            if purchases.isEmpty {
                BrandEmptyState(icon: "doc.badge.plus", title: "No purchases yet", message: "Import a PDF from the Purchases tab to begin.")
            } else {
                ForEach(Array(purchases.prefix(5)), id: \.id) { purchase in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(purchase.merchant).font(.headline)
                            Text("\(purchase.category) · \(purchase.purchasedAt.formatted(date: .abbreviated, time: .omitted))")
                                .font(.caption)
                                .foregroundStyle(GroceryBrand.muted)
                        }
                        Spacer()
                        Text(LedgerEngine.sharedTotal(for: purchase), format: .currency(code: "INR"))
                            .font(.subheadline.bold())
                            .foregroundStyle(GroceryBrand.pine)
                    }
                    if purchase.id != purchases.prefix(5).last?.id { Divider().overlay(GroceryBrand.line) }
                }
            }
        }
        .brandCard()
    }

    private var privacyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            BrandEyebrow(text: "Privacy promise")
            Text("Only the reviewed ledger.").font(.title3.bold())
            Label("PDFs are processed locally, not uploaded.", systemImage: "lock.shield.fill")
            Label("No address, payment mode, card, or UPI details.", systemImage: "checkmark.circle")
        }
        .font(.subheadline)
        .foregroundStyle(GroceryBrand.ink)
        .brandCard()
    }

    private var emptySuggestionMessage: String {
        purchases.count < 2
            ? "Add another reviewed invoice before the app can find a repeat purchase."
            : "No matching tracked product across the saved invoices yet."
    }

    private func suggestionDetail(_ item: RestockSuggestion) -> String {
        if item.needsHistoryCleanup { return "Duplicate same-day imports detected — clean up history before forecasting" }
        if item.usesEstimatedUseBy { return "Estimated to run out around \(item.estimatedNextBuy.formatted(date: .abbreviated, time: .omitted))" }
        if item.usualIntervalDays > 0 { return "Seen \(item.purchaseCount) times · usual interval ~\(item.usualIntervalDays) days" }
        return "Seen \(item.purchaseCount) times · confirm if you want it on your list"
    }
}
