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
        let purchase = Purchase(merchant: "Test shop", category: category, purchasedAt: date, paidBy: paidBy, sourcePDF: nil)
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
    }

    func testPurchaseNeverPersistsRawReceiptDataByDefault() {
        let item = purchase(name: "Milk", date: Date())
        XCTAssertNil(item.sourcePDF)
    }
}
