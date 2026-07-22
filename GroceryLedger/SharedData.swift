import Foundation

enum HouseholdRole: String, Codable, CaseIterable, Sendable {
    case owner
    case partner
}

struct LedgerDate: Codable, Hashable, Sendable {
    let value: Date

    init(_ value: Date) {
        let localComponents = Calendar.current.dateComponents([.year, .month, .day], from: value)
        var utcCalendar = Calendar(identifier: .gregorian)
        utcCalendar.timeZone = TimeZone(secondsFromGMT: 0)!
        self.value = utcCalendar.date(from: localComponents) ?? value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        let parts = text.split(separator: "-").compactMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected an ISO calendar date (yyyy-MM-dd).")
        }
        value = date
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = calendar.dateComponents([.year, .month, .day], from: value)
        let text = String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
        try container.encode(text)
    }
}

struct HouseholdDTO: Codable, Equatable, Sendable {
    let id: UUID
    let name: String
    let createdBy: UUID
    let createdAt: Date
    let archivedAt: Date?
    let purgeAfter: Date?

    enum CodingKeys: String, CodingKey {
        case id, name
        case createdBy = "created_by"
        case createdAt = "created_at"
        case archivedAt = "archived_at"
        case purgeAfter = "purge_after"
    }
}

struct HouseholdMembershipDTO: Codable, Equatable, Sendable {
    let householdID: UUID
    let userID: UUID
    let role: HouseholdRole
    let joinedAt: Date

    enum CodingKeys: String, CodingKey {
        case role
        case householdID = "household_id"
        case userID = "user_id"
        case joinedAt = "joined_at"
    }
}

struct ReviewedPurchaseHeaderDTO: Codable, Equatable, Sendable {
    let id: UUID
    let householdID: UUID
    let label: String
    let category: String
    let amount: Decimal
    let paidBy: UUID
    let purchasedOn: LedgerDate
    let isPersonal: Bool
    let isTrackedForRestock: Bool
    let estimatedUseBy: LedgerDate?
    let createdAt: Date
    let updatedAt: Date
    let archivedAt: Date?
    let archivedBy: UUID?

    enum CodingKeys: String, CodingKey {
        case id, label, category, amount
        case householdID = "household_id"
        case paidBy = "paid_by"
        case purchasedOn = "purchased_on"
        case isPersonal = "is_personal"
        case isTrackedForRestock = "is_tracked_for_restock"
        case estimatedUseBy = "estimated_use_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case archivedAt = "archived_at"
        case archivedBy = "archived_by"
    }
}

struct ReviewedPurchaseItemDTO: Codable, Equatable, Sendable {
    let id: UUID
    let purchaseID: UUID
    let displayOrder: Int
    let name: String
    let quantity: Decimal?
    let unit: String?
    let unitPrice: Decimal?
    let lineTotal: Decimal?
    let isPersonal: Bool
    let isTrackedForRestock: Bool
    let estimatedUseBy: LedgerDate?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, quantity, unit
        case purchaseID = "purchase_id"
        case displayOrder = "display_order"
        case unitPrice = "unit_price"
        case lineTotal = "line_total"
        case isPersonal = "is_personal"
        case isTrackedForRestock = "is_tracked_for_restock"
        case estimatedUseBy = "estimated_use_by"
        case createdAt = "created_at"
    }
}

struct SettlementDTO: Codable, Equatable, Sendable {
    let id: UUID
    let householdID: UUID
    let payer: UUID
    let receiver: UUID
    let amount: Decimal
    let settledOn: LedgerDate
    let createdAt: Date
    let archivedAt: Date?
    let archivedBy: UUID?

    enum CodingKeys: String, CodingKey {
        case id, payer, receiver, amount
        case householdID = "household_id"
        case settledOn = "settled_on"
        case createdAt = "created_at"
        case archivedAt = "archived_at"
        case archivedBy = "archived_by"
    }
}

/// Exact JSON object accepted for each entry in import_reviewed_purchase.p_items.
/// Source-document fields deliberately cannot be represented by this type.
struct ReviewedImportItemPayload: Codable, Equatable, Sendable {
    let name: String
    let quantity: Decimal?
    let unit: String?
    let unitPrice: Decimal?
    let lineTotal: Decimal?
    let isPersonal: Bool
    let isTrackedForRestock: Bool
    let estimatedUseBy: LedgerDate?
    let displayOrder: Int

    enum CodingKeys: String, CodingKey {
        case name, quantity, unit
        case unitPrice = "unit_price"
        case lineTotal = "line_total"
        case isPersonal = "is_personal"
        case isTrackedForRestock = "is_tracked_for_restock"
        case estimatedUseBy = "estimated_use_by"
        case displayOrder = "display_order"
    }
}

/// Parameters for the clean schema's import_reviewed_purchase RPC.
struct ReviewedImportRPCPayload: Codable, Equatable, Sendable {
    let householdID: UUID
    let exactPDFHash: String
    let contentHash: String
    let label: String
    let category: String
    let amount: Decimal
    let purchasedOn: LedgerDate
    let isPersonal: Bool
    let items: [ReviewedImportItemPayload]

    enum CodingKeys: String, CodingKey {
        case householdID = "p_household_id"
        case exactPDFHash = "p_exact_pdf_hash"
        case contentHash = "p_content_hash"
        case label = "p_label"
        case category = "p_category"
        case amount = "p_amount"
        case purchasedOn = "p_purchased_on"
        case isPersonal = "p_is_personal"
        case items = "p_items"
    }
}

enum SharedDataMappingError: Error, Equatable {
    case missingMemberID(LedgerPerson)
    case emptyPurchase
    case invalidFingerprint
}

struct SharedPurchaseBundle: Equatable, Sendable {
    let header: ReviewedPurchaseHeaderDTO
    let items: [ReviewedPurchaseItemDTO]
}

enum SharedDataMapper {
    static func purchase(
        _ purchase: Purchase,
        householdID: UUID,
        memberIDs: [LedgerPerson: UUID]
    ) throws -> SharedPurchaseBundle {
        guard let paidBy = LedgerPerson(rawValue: purchase.paidBy), let paidByID = memberIDs[paidBy] else {
            throw SharedDataMappingError.missingMemberID(LedgerPerson(rawValue: purchase.paidBy) ?? .ekta)
        }
        guard !purchase.items.isEmpty else { throw SharedDataMappingError.emptyPurchase }

        let sortedItems = purchase.items.sorted { lhs, rhs in
            lhs.displayOrder == rhs.displayOrder
                ? lhs.id.uuidString < rhs.id.uuidString
                : lhs.displayOrder < rhs.displayOrder
        }
        let orderedItems = sortedItems.enumerated().map { offset, item in
            ReviewedPurchaseItemDTO(
                id: item.id,
                purchaseID: purchase.id,
                displayOrder: offset,
                name: item.name,
                quantity: item.quantity,
                unit: nil,
                unitPrice: nil,
                lineTotal: item.amount,
                isPersonal: item.isPersonal,
                isTrackedForRestock: !item.isPersonal && item.isTrackedForRestock,
                estimatedUseBy: item.isPersonal ? nil : item.estimatedUseBy.map(LedgerDate.init),
                createdAt: purchase.createdAt
            )
        }
        let isPersonal = orderedItems.allSatisfy(\.isPersonal)
        let header = ReviewedPurchaseHeaderDTO(
            id: purchase.id,
            householdID: householdID,
            label: purchase.merchant,
            category: purchase.category,
            amount: purchase.items.reduce(0) { $0 + $1.amount },
            paidBy: paidByID,
            purchasedOn: LedgerDate(purchase.purchasedAt),
            isPersonal: isPersonal,
            isTrackedForRestock: false,
            estimatedUseBy: nil,
            createdAt: purchase.createdAt,
            updatedAt: purchase.createdAt,
            archivedAt: nil,
            archivedBy: nil
        )
        return SharedPurchaseBundle(header: header, items: orderedItems)
    }

    static func settlement(
        _ settlement: Settlement,
        householdID: UUID,
        memberIDs: [LedgerPerson: UUID]
    ) throws -> SettlementDTO {
        guard let payer = LedgerPerson(rawValue: settlement.payer), let payerID = memberIDs[payer] else {
            throw SharedDataMappingError.missingMemberID(LedgerPerson(rawValue: settlement.payer) ?? .ekta)
        }
        guard let receiver = LedgerPerson(rawValue: settlement.receiver), let receiverID = memberIDs[receiver] else {
            throw SharedDataMappingError.missingMemberID(LedgerPerson(rawValue: settlement.receiver) ?? .ritesh)
        }
        return SettlementDTO(
            id: settlement.id,
            householdID: householdID,
            payer: payerID,
            receiver: receiverID,
            amount: settlement.amount,
            settledOn: LedgerDate(settlement.settledAt),
            createdAt: settlement.settledAt,
            archivedAt: nil,
            archivedBy: nil
        )
    }

    static func reviewedImport(
        from bundle: SharedPurchaseBundle,
        exactPDFHash: String,
        contentHash: String
    ) throws -> ReviewedImportRPCPayload {
        guard isSHA256(exactPDFHash), isSHA256(contentHash) else {
            throw SharedDataMappingError.invalidFingerprint
        }
        return ReviewedImportRPCPayload(
            householdID: bundle.header.householdID,
            exactPDFHash: exactPDFHash,
            contentHash: contentHash,
            label: bundle.header.label,
            category: bundle.header.category,
            amount: bundle.header.amount,
            purchasedOn: bundle.header.purchasedOn,
            isPersonal: bundle.header.isPersonal,
            items: bundle.items.map {
                ReviewedImportItemPayload(
                    name: $0.name,
                    quantity: $0.quantity,
                    unit: $0.unit,
                    unitPrice: $0.unitPrice,
                    lineTotal: $0.lineTotal,
                    isPersonal: $0.isPersonal,
                    isTrackedForRestock: $0.isTrackedForRestock,
                    estimatedUseBy: $0.estimatedUseBy,
                    displayOrder: $0.displayOrder
                )
            }
        )
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
        }
    }
}

enum SharedBalanceCalculator {
    static func balance(
        for memberID: UUID,
        memberCount: Int,
        purchases: [SharedPurchaseBundle],
        settlements: [SettlementDTO]
    ) -> Decimal {
        guard memberCount > 0 else { return 0 }
        var balance: Decimal = 0
        for purchase in purchases {
            let sharedTotal = purchase.items
                .filter { !$0.isPersonal }
                .compactMap(\.lineTotal)
                .reduce(0, +)
            balance -= sharedTotal / Decimal(memberCount)
            if purchase.header.paidBy == memberID { balance += sharedTotal }
        }
        for settlement in settlements {
            if settlement.payer == memberID { balance += settlement.amount }
            if settlement.receiver == memberID { balance -= settlement.amount }
        }
        return balance
    }
}

enum SharedSyncState: Equatable, Sendable {
    case notConfigured
    case signedOut
    case readyOffline(lastSuccessfulSync: Date?)
    case syncing(lastSuccessfulSync: Date?)
    case pendingChanges(count: Int, lastSuccessfulSync: Date?)
    case failed(message: String, pendingChanges: Int, lastSuccessfulSync: Date?)
}

/// Networking can implement this later. No implementation in the app currently
/// claims that a remote connection or successful synchronization exists.
@MainActor
protocol SharedLedgerSyncClient: AnyObject {
    var state: SharedSyncState { get }
    func synchronize() async
}

@MainActor
final class UnconfiguredSharedLedgerSyncClient: SharedLedgerSyncClient {
    private(set) var state: SharedSyncState = .notConfigured

    func synchronize() async {
        state = .notConfigured
    }
}
