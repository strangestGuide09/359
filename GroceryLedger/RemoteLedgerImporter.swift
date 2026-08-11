import Foundation
import SwiftData

@MainActor
enum RemoteLedgerImporter {
    static func apply(_ snapshot: RemoteLedgerSnapshot, to context: ModelContext) throws {
        let people = personMap(snapshot.memberships)
        let purchases = try context.fetch(FetchDescriptor<Purchase>())
        let purchaseByID = Dictionary(uniqueKeysWithValues: purchases.map { ($0.id, $0) })
        for remote in snapshot.purchases {
            guard let paidBy = people[remote.paidBy] else { continue }
            let purchase = purchaseByID[remote.id] ?? Purchase(
                id: remote.id,
                merchant: remote.label,
                category: remote.category,
                purchasedAt: remote.purchasedOn.value,
                createdAt: remote.createdAt,
                paidBy: paidBy,
                parsingNote: "Synced reviewed purchase"
            )
            purchase.merchant = remote.label
            purchase.category = remote.category.rawValue
            purchase.purchasedAt = remote.purchasedOn.value
            purchase.paidBy = paidBy.rawValue
            if purchaseByID[remote.id] == nil { context.insert(purchase) }

            let itemByID = Dictionary(uniqueKeysWithValues: purchase.items.map { ($0.id, $0) })
            for remoteItem in remote.items {
                let item = itemByID[remoteItem.id] ?? PurchaseItem(
                    id: remoteItem.id,
                    name: remoteItem.name,
                    amount: remoteItem.lineTotal ?? 0
                )
                item.name = remoteItem.name
                item.amount = remoteItem.lineTotal ?? 0
                item.quantity = remoteItem.quantity ?? 1
                item.displayOrder = remoteItem.displayOrder
                item.isPersonal = remoteItem.isPersonal
                item.isTrackedForRestock = !remoteItem.isPersonal && remoteItem.isTrackedForRestock
                item.estimatedUseBy = remoteItem.isPersonal ? nil : remoteItem.estimatedUseBy?.value
                if itemByID[remoteItem.id] == nil {
                    item.purchase = purchase
                    purchase.items.append(item)
                }
            }
        }

        let settlements = try context.fetch(FetchDescriptor<Settlement>())
        let settlementByID = Dictionary(uniqueKeysWithValues: settlements.map { ($0.id, $0) })
        for remote in snapshot.settlements {
            guard let payer = people[remote.payer], let receiver = people[remote.receiver] else { continue }
            let settlement = settlementByID[remote.id] ?? Settlement(
                id: remote.id,
                payer: payer,
                receiver: receiver,
                amount: remote.amount,
                settledAt: remote.settledOn.value,
                note: "Synced settlement"
            )
            settlement.payer = payer.rawValue
            settlement.receiver = receiver.rawValue
            settlement.amount = remote.amount
            settlement.settledAt = remote.settledOn.value
            if settlementByID[remote.id] == nil { context.insert(settlement) }
        }
        try context.save()
    }

    static func personMap(_ memberships: [RemoteMembership]) -> [UUID: LedgerPerson] {
        Dictionary(uniqueKeysWithValues: memberships.map { member in
            let normalised = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if normalised.contains("ritesh") { return (member.userID, .ritesh) }
            if normalised.contains("ekta") { return (member.userID, .ekta) }
            return (member.userID, member.role == .owner ? .ekta : .ritesh)
        })
    }
}
