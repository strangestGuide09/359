import Foundation
import SwiftData

@MainActor
enum RemoteSyncOutbox {
    static func flush(using sync: SupabaseLedgerController, context: ModelContext) async {
        guard let snapshot = sync.snapshot else { return }
        let members = RemoteLedgerImporter.personMap(snapshot.memberships)
        let memberIDs = Dictionary(uniqueKeysWithValues: members.map { ($0.value, $0.key) })

        do {
            let pendingPurchases = try context.fetch(FetchDescriptor<Purchase>(predicate: #Predicate { $0.needsRemoteSync }))
            for purchase in pendingPurchases {
                let bundle = try SharedDataMapper.purchase(purchase, householdID: snapshot.household.id, memberIDs: memberIDs)
                if purchase.isRemoteBacked {
                    try await sync.uploadReviewedUpdate(SharedDataMapper.reviewedUpdate(from: bundle))
                    purchase.needsRemoteSync = false
                } else {
                    guard let exact = purchase.exactPDFHash, let content = purchase.contentHash else { continue }
                    let payload = try SharedDataMapper.reviewedImport(from: bundle, exactPDFHash: exact, contentHash: content)
                    try await sync.uploadReviewedPurchase(payload)
                    context.delete(purchase)
                }
                try context.save()
            }

            let pendingSettlements = try context.fetch(FetchDescriptor<Settlement>(predicate: #Predicate { $0.needsRemoteSync }))
            for settlement in pendingSettlements {
                let payload = try SharedDataMapper.settlement(settlement, householdID: snapshot.household.id, memberIDs: memberIDs)
                try await sync.uploadSettlement(payload, allocations: settlement.receiptAllocations)
                context.delete(settlement)
                try context.save()
            }
        } catch {
            sync.notePendingUploadFailure(error.localizedDescription)
        }
    }
}
