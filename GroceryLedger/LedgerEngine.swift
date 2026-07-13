import Foundation

struct RestockSuggestion: Identifiable {
    let id: String
    let name: String
    let lastBought: Date
    let estimatedNextBuy: Date
    let usualIntervalDays: Int
    let purchaseCount: Int
    let needsHistoryCleanup: Bool
    let usesEstimatedUseBy: Bool
}

struct BalanceSummary {
    var ekta: Decimal
    var ritesh: Decimal

    var settlementMessage: String {
        let amount = abs(ekta)
        guard amount > 0.005 else { return "All settled up" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "INR"
        formatter.maximumFractionDigits = 2
        let money = formatter.string(from: amount as NSDecimalNumber) ?? "₹0"
        return ekta > 0 ? "Ritesh owes Ekta \(money)" : "Ekta owes Ritesh \(money)"
    }
}

enum LedgerEngine {
    static func sharedTotal(for purchase: Purchase) -> Decimal {
        purchase.items.filter { !$0.isPersonal }.reduce(0) { $0 + $1.amount }
    }

    static func summary(purchases: [Purchase], settlements: [Settlement]) -> BalanceSummary {
        // A settlement only offsets a purchase balance. Deleting every purchase must never create a new debt.
        guard !purchases.isEmpty else { return BalanceSummary(ekta: 0, ritesh: 0) }
        var ekta: Decimal = 0
        var ritesh: Decimal = 0

        for purchase in purchases {
            let half = sharedTotal(for: purchase) / 2
            if purchase.paidBy == LedgerPerson.ekta.rawValue {
                ekta += half
                ritesh -= half
            } else {
                ritesh += half
                ekta -= half
            }
        }
        for settlement in settlements {
            if settlement.payer == LedgerPerson.ekta.rawValue {
                ekta += settlement.amount
                ritesh -= settlement.amount
            } else {
                ritesh += settlement.amount
                ekta -= settlement.amount
            }
        }
        return BalanceSummary(ekta: ekta, ritesh: ritesh)
    }

    /// A transparent, local-only cue. Only explicitly tracked, non-personal
    /// grocery/household items are considered. An optional estimated use-by date
    /// overrides the purchase cadence because it is a more direct input.
    static func possibleBuys(from purchases: [Purchase], referenceDate: Date = .now) -> [RestockSuggestion] {
        let calendar = Calendar.current
        let restockCategories = Set([ExpenseCategory.groceries.rawValue, ExpenseCategory.household.rawValue])
        let trackedItems = purchases
            .filter { restockCategories.contains($0.category) }
            .flatMap(\.items)
            .filter { !$0.isPersonal && $0.isTrackedForRestock }
        let grouped = Dictionary(grouping: trackedItems) { normalizedName($0.name) }
        return grouped.compactMap { key, items in
            // One product may appear more than once on an invoice. Collapse those
            // lines first, so a receipt cannot manufacture a repeat pattern.
            let purchasesByID = Dictionary(grouping: items.compactMap { item in
                item.purchase.map { (purchase: $0, name: item.name) }
            }, by: { $0.purchase.id })
            guard purchasesByID.count >= 2 else { return nil }
            let purchaseDates = purchasesByID.values.compactMap { values in
                values.first.map { calendar.startOfDay(for: $0.purchase.purchasedAt) }
            }.sorted()
            let dates = Array(Set(purchaseDates)).sorted()
            let needsHistoryCleanup = dates.count < purchaseDates.count
            // With a small, evolving history, the most useful cue is the latest
            // completed buying cycle—not an average distorted by older purchases.
            let days: Int
            // Multiple purchases for the same product on one date are usually a
            // duplicate import. Show the product, but do not invent a cadence.
            if dates.count >= 2 && !needsHistoryCleanup {
                days = max(1, calendar.dateComponents([.day], from: dates[dates.count - 2], to: dates[dates.count - 1]).day ?? 0)
            } else {
                days = 0
            }
            guard let lastBought = dates.last else { return nil }
            // A prior pack's estimate must not make a newer purchase look due
            // later. Consider estimates only from the latest purchase day.
            let latestUseBy = items
                .filter { item in
                    guard let purchase = item.purchase else { return false }
                    return calendar.startOfDay(for: purchase.purchasedAt) == lastBought
                }
                .compactMap(\.estimatedUseBy)
                .max()
            let estimatedNextBuy = latestUseBy ?? (days > 0 ? calendar.date(byAdding: .day, value: days, to: lastBought) ?? lastBought : lastBought)
            return RestockSuggestion(
                id: key,
                name: items.last?.name ?? key,
                lastBought: lastBought,
                estimatedNextBuy: estimatedNextBuy,
                usualIntervalDays: days,
                purchaseCount: purchasesByID.count,
                needsHistoryCleanup: needsHistoryCleanup,
                usesEstimatedUseBy: latestUseBy != nil
            )
        }
        .sorted { $0.purchaseCount > $1.purchaseCount }
    }

    private static func normalizedName(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: "(pack)", with: "")
            .replacingOccurrences(of: "(pouch)", with: "")
            .replacingOccurrences(of: "(box)", with: "")
            .replacingOccurrences(of: "(packet)", with: "")
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }
}
