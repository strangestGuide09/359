import Foundation
import SwiftData

enum LedgerPerson: String, CaseIterable, Identifiable, Codable, Hashable, Sendable {
    case ekta = "Ekta"
    case ritesh = "Ritesh"

    var id: String { rawValue }
}

enum ExpenseCategory: String, CaseIterable, Identifiable, Codable, Hashable, Sendable {
    case groceries = "Groceries"
    case food = "Food"
    case wifi = "Wi-Fi"
    case water = "Water"
    case household = "Household"
    case other = "Other"

    var id: String { rawValue }
}

@Model
final class Purchase {
    @Attribute(.unique) var id: UUID
    var merchant: String
    // A stored default lets existing local ledgers migrate safely when this
    // category field is introduced; older purchases are groceries by default.
    var category: String = "Groceries"
    var purchasedAt: Date
    var createdAt: Date
    var paidBy: String
    var needsRemoteSync: Bool = false
    var isRemoteBacked: Bool = false
    var exactPDFHash: String?
    var contentHash: String?
    @Relationship(deleteRule: .cascade, inverse: \PurchaseItem.purchase) var items: [PurchaseItem]

    init(id: UUID = UUID(), merchant: String, category: ExpenseCategory = .groceries, purchasedAt: Date = .now, createdAt: Date = .now, paidBy: LedgerPerson = .ekta) {
        self.id = id
        self.merchant = merchant
        self.category = category.rawValue
        self.purchasedAt = purchasedAt
        self.createdAt = createdAt
        self.paidBy = paidBy.rawValue
        self.items = []
    }
}

@Model
final class PurchaseItem {
    @Attribute(.unique) var id: UUID
    var name: String
    var amount: Decimal
    var quantity: Decimal
    var displayOrder: Int = 0
    var isPersonal: Bool
    var isTrackedForRestock: Bool
    var estimatedUseBy: Date?
    var purchase: Purchase?

    init(id: UUID = UUID(), name: String, amount: Decimal, quantity: Decimal = 1, displayOrder: Int = 0, isPersonal: Bool = false, isTrackedForRestock: Bool = false, estimatedUseBy: Date? = nil) {
        self.id = id
        self.name = name
        self.amount = amount
        self.quantity = quantity
        self.displayOrder = displayOrder
        self.isPersonal = isPersonal
        self.isTrackedForRestock = isTrackedForRestock
        self.estimatedUseBy = estimatedUseBy
    }
}

@Model
final class Settlement {
    @Attribute(.unique) var id: UUID
    var payer: String
    var receiver: String
    var amount: Decimal
    var settledAt: Date
    var note: String
    var needsRemoteSync: Bool = false
    var isRemoteBacked: Bool = false
    /// JSON for reviewed receipt allocations only. It contains stable database
    /// identifiers and amounts; no receipt source document data is stored here.
    var allocationsData: Data = Data()

    init(id: UUID = UUID(), payer: LedgerPerson, receiver: LedgerPerson, amount: Decimal, settledAt: Date = .now, note: String = "") {
        self.id = id
        self.payer = payer.rawValue
        self.receiver = receiver.rawValue
        self.amount = amount
        self.settledAt = settledAt
        self.note = note
    }

    var receiptAllocations: [SettlementAllocation] {
        get { (try? JSONDecoder().decode([SettlementAllocation].self, from: allocationsData)) ?? [] }
        set { allocationsData = (try? JSONEncoder().encode(newValue)) ?? Data() }
    }

    var isReceiptBacked: Bool { !receiptAllocations.isEmpty }
}

struct SettlementAllocation: Codable, Equatable, Identifiable, Sendable {
    let purchaseID: UUID
    let purchaseItemID: UUID?
    let amount: Decimal

    var id: String { "\(purchaseID.uuidString):\(purchaseItemID?.uuidString ?? "receipt")" }
}
