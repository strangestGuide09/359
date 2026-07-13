import Foundation
import SwiftData

enum LedgerPerson: String, CaseIterable, Identifiable, Codable {
    case ekta = "Ekta"
    case ritesh = "Ritesh"

    var id: String { rawValue }
}

enum ExpenseCategory: String, CaseIterable, Identifiable, Codable {
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
    var invoiceNumber: String?
    var purchasedAt: Date
    var createdAt: Date
    var paidBy: String
    var sourcePDF: Data?
    var parsingNote: String?
    @Relationship(deleteRule: .cascade, inverse: \PurchaseItem.purchase) var items: [PurchaseItem]

    init(merchant: String, category: ExpenseCategory = .groceries, invoiceNumber: String? = nil, purchasedAt: Date = .now, paidBy: LedgerPerson = .ekta, sourcePDF: Data? = nil, parsingNote: String? = nil) {
        self.id = UUID()
        self.merchant = merchant
        self.category = category.rawValue
        self.invoiceNumber = invoiceNumber
        self.purchasedAt = purchasedAt
        self.createdAt = .now
        self.paidBy = paidBy.rawValue
        self.sourcePDF = sourcePDF
        self.parsingNote = parsingNote
        self.items = []
    }
}

@Model
final class PurchaseItem {
    @Attribute(.unique) var id: UUID
    var name: String
    var amount: Decimal
    var quantity: Decimal
    var isPersonal: Bool
    var isTrackedForRestock: Bool
    var estimatedUseBy: Date?
    var purchase: Purchase?

    init(name: String, amount: Decimal, quantity: Decimal = 1, isPersonal: Bool = false, isTrackedForRestock: Bool = false, estimatedUseBy: Date? = nil) {
        self.id = UUID()
        self.name = name
        self.amount = amount
        self.quantity = quantity
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

    init(payer: LedgerPerson, receiver: LedgerPerson, amount: Decimal, settledAt: Date = .now, note: String = "") {
        self.id = UUID()
        self.payer = payer.rawValue
        self.receiver = receiver.rawValue
        self.amount = amount
        self.settledAt = settledAt
        self.note = note
    }
}
