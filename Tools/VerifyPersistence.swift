import Foundation
import SwiftData

@main
struct VerifyPersistence {
    static func main() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: Purchase.self, PurchaseItem.self, Settlement.self,
            configurations: configuration
        )
        let context = ModelContext(container)
        let purchase = Purchase(merchant: "Persistence check", category: .groceries, invoiceNumber: "TEST-VERIFY", paidBy: .ekta)
        let item = PurchaseItem(name: "Test item", amount: 100)
        item.purchase = purchase
        purchase.items.append(item)
        context.insert(purchase)
        try context.save()

        let saved = try context.fetch(FetchDescriptor<Purchase>())
        guard saved.count == 1, saved[0].merchant == "Persistence check", saved[0].category == "Groceries", saved[0].items.count == 1 else {
            fatalError("Persistence verification failed")
        }
        print("Persistence verification passed")
    }
}
