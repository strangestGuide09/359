import SwiftData
import XCTest
@testable import GroceryLedger

@MainActor
final class GroceryLedgerCoreTests: XCTestCase {
    private func purchase(
        name: String,
        date: Date,
        paidBy: LedgerPerson = .ekta,
        category: ExpenseCategory = .groceries,
        amount: Decimal = 100,
        tracked: Bool = true,
        personal: Bool = false,
        useBy: Date? = nil
    ) -> Purchase {
        let purchase = Purchase(merchant: "Test shop", category: category, purchasedAt: date, paidBy: paidBy)
        let item = PurchaseItem(name: name, amount: amount, isPersonal: personal, isTrackedForRestock: tracked, estimatedUseBy: useBy)
        item.purchase = purchase
        purchase.items.append(item)
        return purchase
    }

    func testPersonalItemsDoNotCreateDebt() {
        let shared = purchase(name: "Milk", date: Date(), amount: 200)
        let personal = purchase(name: "Personal snack", date: Date(), amount: 90, personal: true)

        let result = LedgerEngine.summary(purchases: [shared, personal], settlements: [])

        XCTAssertEqual(result.ekta, Decimal(100))
        XCTAssertEqual(result.ritesh, Decimal(-100))
    }

    func testSettlementWithoutPurchasesNeverCreatesDebt() {
        let settlement = Settlement(payer: .ekta, receiver: .ritesh, amount: 500)

        let result = LedgerEngine.summary(purchases: [], settlements: [settlement])

        XCTAssertEqual(result.ekta, 0)
        XCTAssertEqual(result.ritesh, 0)
    }

    func testLatestTwoDistinctPurchasesSetInterval() {
        let calendar = Calendar(identifier: .gregorian)
        let first = calendar.date(from: DateComponents(year: 2026, month: 7, day: 1))!
        let second = calendar.date(from: DateComponents(year: 2026, month: 7, day: 9))!
        let old = calendar.date(from: DateComponents(year: 2026, month: 4, day: 1))!

        let result = LedgerEngine.possibleBuys(from: [purchase(name: "Paneer (Pouch)", date: old), purchase(name: "Paneer (Pouch)", date: first), purchase(name: "Paneer (Pouch)", date: second)])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].usualIntervalDays, 8)
        XCTAssertEqual(result[0].estimatedNextBuy, calendar.date(from: DateComponents(year: 2026, month: 7, day: 17)))
    }

    func testEstimatedUseByOverridesRepeatCadence() {
        let calendar = Calendar(identifier: .gregorian)
        let first = calendar.date(from: DateComponents(year: 2026, month: 7, day: 1))!
        let second = calendar.date(from: DateComponents(year: 2026, month: 7, day: 9))!
        let useBy = calendar.date(from: DateComponents(year: 2026, month: 7, day: 11))!

        let result = LedgerEngine.possibleBuys(from: [purchase(name: "Tofu", date: first), purchase(name: "Tofu", date: second, useBy: useBy)])

        XCTAssertEqual(result.first?.estimatedNextBuy, useBy)
        XCTAssertEqual(result.first?.usesEstimatedUseBy, true)
    }

    func testFoodAndUntrackedItemsNeverBecomeRestockSuggestions() {
        let date = Date()
        let groceries = purchase(name: "Rice", date: date, tracked: false)
        let food = purchase(name: "Pizza", date: date.addingTimeInterval(86_400), category: .food)

        XCTAssertTrue(LedgerEngine.possibleBuys(from: [groceries, food]).isEmpty)
    }

    func testFoodInvoiceParserReadsOnlySanitisedFieldsNeededForLedger() throws {
        let invoice = try InvoiceParser.parse(text: """
        Zomato Food Order
        Restaurant Name: Test Kitchen
        Order Time: 11 July 2026, 07:57 PM
        Veg Wrap 2 ₹100.00 ₹200.00
        Total ₹200.00
        """)

        XCTAssertEqual(invoice.merchant, "Test Kitchen")
        XCTAssertEqual(invoice.category, .food)
        XCTAssertEqual(invoice.suggestedTotal, Decimal(string: "200.00"))
        XCTAssertEqual(invoice.items.count, 1)
        XCTAssertEqual(invoice.items.first?.name, "Veg Wrap")
        XCTAssertEqual(invoice.items.first?.isPersonal, false)
        XCTAssertEqual(invoice.items.first?.isTrackedForRestock, false)
        XCTAssertNil(invoice.items.first?.estimatedUseBy)
    }

    func testPurchasePersistsReviewedLedgerFields() {
        let item = purchase(name: "Milk", date: Date())
        XCTAssertEqual(item.merchant, "Test shop")
        XCTAssertEqual(item.items.first?.name, "Milk")
        XCTAssertEqual(item.items.first?.amount, 100)
    }

    func testReviewReconciliationReportsExactAndMismatchedTotals() {
        let items = [
            ParsedInvoiceItem(name: "Rice", amount: 120, quantity: 1),
            ParsedInvoiceItem(name: "Milk", amount: 80, quantity: 2)
        ]

        XCTAssertEqual(InvoiceReviewPolicy.itemTotal(items), 200)
        XCTAssertEqual(InvoiceReviewPolicy.reconciliationDifference(items: items, invoiceTotal: 200), 0)
        XCTAssertEqual(InvoiceReviewPolicy.reconciliationDifference(items: items, invoiceTotal: 210), -10)
        XCTAssertNil(InvoiceReviewPolicy.reconciliationDifference(items: items, invoiceTotal: nil))
    }

    func testPersonalOrUnsupportedCategoryItemsCannotDriveRestock() {
        let shared = ParsedInvoiceItem(name: "Rice", amount: 100, quantity: 1, isTrackedForRestock: true)
        let personal = ParsedInvoiceItem(name: "Snack", amount: 50, quantity: 1, isPersonal: true, isTrackedForRestock: true)

        XCTAssertTrue(InvoiceReviewPolicy.shouldTrackForRestock(item: shared, category: .groceries))
        XCTAssertFalse(InvoiceReviewPolicy.shouldTrackForRestock(item: personal, category: .groceries))
        XCTAssertFalse(InvoiceReviewPolicy.shouldTrackForRestock(item: shared, category: .food))
    }

    func testParsingReviewDraftCreatesNoPersistentPurchaseUntilSave() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: Purchase.self, PurchaseItem.self, Settlement.self,
            configurations: configuration
        )
        let context = ModelContext(container)

        _ = try InvoiceParser.parse(text: """
        Zomato Food Order
        Restaurant Name: Test Kitchen
        Veg Wrap 1 ₹100.00 ₹100.00
        Total ₹100.00
        """)

        XCTAssertTrue(try context.fetch(FetchDescriptor<Purchase>()).isEmpty)
    }

    func testReviewedImportPayloadContainsOnlySchemaApprovedFields() throws {
        let householdID = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
        let ektaID = UUID(uuidString: "20000000-0000-0000-0000-000000000001")!
        let purchase = Purchase(merchant: "Mixed basket", category: .groceries, paidBy: .ekta)
        let personal = PurchaseItem(name: "Private snack", amount: 50, quantity: 1, displayOrder: 1, isPersonal: true)
        let shared = PurchaseItem(name: "Rice", amount: 200, quantity: 2, displayOrder: 0, isTrackedForRestock: true)
        for item in [personal, shared] {
            item.purchase = purchase
            purchase.items.append(item)
        }

        let bundle = try SharedDataMapper.purchase(purchase, householdID: householdID, memberIDs: [.ekta: ektaID])
        let payload = try SharedDataMapper.reviewedImport(
            from: bundle,
            exactPDFHash: String(repeating: "a", count: 64),
            contentHash: String(repeating: "b", count: 64)
        )
        let data = try JSONEncoder().encode(payload)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(Set(object.keys), [
            "p_household_id", "p_exact_pdf_hash", "p_content_hash", "p_label",
            "p_category", "p_amount", "p_purchased_on", "p_is_personal", "p_items"
        ])
        let encodedItems = try XCTUnwrap(object["p_items"] as? [[String: Any]])
        let allowedItemKeys: Set<String> = [
            "name", "quantity", "unit", "unit_price", "line_total", "is_personal",
            "is_tracked_for_restock", "estimated_use_by", "display_order"
        ]
        XCTAssertTrue(encodedItems.allSatisfy { Set($0.keys).isSubset(of: allowedItemKeys) })
        XCTAssertEqual(encodedItems.map { $0["display_order"] as? Int }, [0, 1])

        let forbiddenKeys: Set<String> = [
            "pdf", "pdf_bytes", "raw_text", "extracted_text", "ocr_text", "file_path",
            "file_name", "filename", "address", "card", "bank", "upi", "payment_mode",
            "payment_credentials"
        ]
        XCTAssertTrue(Set(object.keys).isDisjoint(with: forbiddenKeys))
        XCTAssertTrue(encodedItems.allSatisfy { Set($0.keys).isDisjoint(with: forbiddenKeys) })
    }

    func testStableIDsAndMixedReceiptBalanceMatchCleanSchemaRules() throws {
        let householdID = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
        let ektaID = UUID(uuidString: "20000000-0000-0000-0000-000000000001")!
        let riteshID = UUID(uuidString: "20000000-0000-0000-0000-000000000002")!
        let purchase = Purchase(merchant: "Mixed basket", category: .groceries, paidBy: .ekta)
        let shared = PurchaseItem(name: "Shared groceries", amount: 200, displayOrder: 0)
        let personal = PurchaseItem(name: "Ekta personal", amount: 100, displayOrder: 1, isPersonal: true)
        for item in [shared, personal] {
            item.purchase = purchase
            purchase.items.append(item)
        }
        let bundle = try SharedDataMapper.purchase(
            purchase,
            householdID: householdID,
            memberIDs: [.ekta: ektaID, .ritesh: riteshID]
        )
        let settlement = SettlementDTO(
            id: UUID(),
            householdID: householdID,
            payer: riteshID,
            receiver: ektaID,
            amount: 25,
            settledOn: LedgerDate(Date()),
            createdAt: Date(),
            archivedAt: nil,
            archivedBy: nil
        )

        XCTAssertEqual(bundle.header.id, purchase.id)
        XCTAssertEqual(bundle.items.map(\.id), [shared.id, personal.id])
        XCTAssertEqual(bundle.header.amount, 300)
        XCTAssertFalse(bundle.header.isPersonal)
        XCTAssertEqual(SharedBalanceCalculator.balance(for: ektaID, memberCount: 2, purchases: [bundle], settlements: [settlement]), 75)
        XCTAssertEqual(SharedBalanceCalculator.balance(for: riteshID, memberCount: 2, purchases: [bundle], settlements: [settlement]), -75)
    }

    func testInvalidDuplicateFingerprintIsRejectedBeforeNetworking() throws {
        let purchase = Purchase(merchant: "Test", paidBy: .ekta)
        let item = PurchaseItem(name: "Milk", amount: 100)
        item.purchase = purchase
        purchase.items.append(item)
        let bundle = try SharedDataMapper.purchase(
            purchase,
            householdID: UUID(),
            memberIDs: [.ekta: UUID()]
        )

        XCTAssertThrowsError(try SharedDataMapper.reviewedImport(
            from: bundle,
            exactPDFHash: "/private/receipt.pdf",
            contentHash: "OCR receipt text"
        )) { error in
            XCTAssertEqual(error as? SharedDataMappingError, .invalidFingerprint)
        }
    }
}
