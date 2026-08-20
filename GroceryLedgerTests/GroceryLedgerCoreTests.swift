import SwiftData
import XCTest
@testable import GroceryLedger

@MainActor
final class GroceryLedgerCoreTests: XCTestCase {
    private func temporaryPendingDraftStore() throws -> PendingInvoiceDraftStore {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("GroceryLedgerTests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return PendingInvoiceDraftStore(rootURL: root)
    }

    private func temporaryPDF(named name: String = "private-invoice-name.pdf") throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(name)")
        try Data("%PDF-1.7\n%%EOF".utf8).write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func token(_ text: String, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat = 40) -> PositionedInvoiceToken {
        PositionedInvoiceToken(text: text, x: x, y: y, width: width)
    }

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

    func testDelayedUploadUsesReviewedReceiptDateForTimelinePayloadAndRestock() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        let july3 = calendar.date(from: DateComponents(year: 2026, month: 7, day: 3))!
        let august13 = calendar.date(from: DateComponents(year: 2026, month: 8, day: 13))!

        let delayed = purchase(name: "Milk", date: july3)
        delayed.createdAt = august13 // Uploaded 41 days after the receipt event.
        let sameDay = purchase(name: "Milk", date: august13)
        sameDay.createdAt = august13

        let chronology = LedgerEngine.purchasesByReceiptDate([delayed, sameDay])
        XCTAssertEqual(chronology.map(\.id), [sameDay.id, delayed.id])
        XCTAssertEqual(chronology.map(\.purchasedAt), [august13, july3])

        let suggestions = LedgerEngine.possibleBuys(from: [sameDay, delayed], referenceDate: august13)
        XCTAssertEqual(suggestions.first?.lastBought, august13)
        XCTAssertEqual(suggestions.first?.usualIntervalDays, 41)
        XCTAssertEqual(
            suggestions.first?.estimatedNextBuy,
            calendar.date(from: DateComponents(year: 2026, month: 9, day: 23))
        )

        let householdID = UUID(), ektaID = UUID()
        let bundle = try SharedDataMapper.purchase(delayed, householdID: householdID, memberIDs: [.ekta: ektaID])
        let payload = try SharedDataMapper.reviewedImport(
            from: bundle,
            exactPDFHash: String(repeating: "a", count: 64),
            contentHash: String(repeating: "b", count: 64)
        )
        XCTAssertEqual(payload.purchasedOn.isoString, "2026-07-03")
        XCTAssertEqual(bundle.header.createdAt, august13)
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
        Total Paid ₹200.00
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

    func testParserReadsNumericAndMonthNameReceiptDatesWithoutUsingUploadDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        let numeric = try InvoiceParser.parse(text: """
        BLINK COMMERCE
        Invoice Date: 03/07/2025
        """)
        let named = try InvoiceParser.parse(text: """
        BLINK COMMERCE
        Purchase Date: 13 August 2025
        """)
        XCTAssertEqual(numeric.date.map { calendar.dateComponents([.year, .month, .day], from: $0) }, DateComponents(year: 2025, month: 7, day: 3))
        XCTAssertEqual(named.date.map { calendar.dateComponents([.year, .month, .day], from: $0) }, DateComponents(year: 2025, month: 8, day: 13))

        let missing = try InvoiceParser.parse(text: "BLINK COMMERCE\nNo printed purchase date")
        XCTAssertNil(missing.date, "a missing receipt date must require review instead of silently becoming today")
    }

    func testPositionedParserRejectsFooterYearAndKeepsPaidFeeRows() throws {
        let page = [
            token("Sr.", 10, 900), token("Description", 140, 900, 80), token("Qty", 430, 900), token("Total", 600, 900, 48),
            token("1", 10, 860), token("Organic", 140, 860), token("Milk", 205, 860), token("1", 430, 860), token("80.00", 600, 860, 42),
            token("2", 10, 820), token("Handling", 140, 820), token("fee", 210, 820), token("1", 430, 820), token("10.00", 600, 820, 42),
            token("3", 10, 780), token("Paneer", 140, 780), token("2025", 430, 755), token("145.00", 600, 780, 48),
            token("and other terms and conditions", 140, 750, 180)
        ]
        let invoice = try InvoiceParser.parse(text: "Invoice Date: 03-Jul-2025", positionedPages: [page])
        XCTAssertEqual(invoice.items.map(\.name), ["Organic Milk", "Handling fee"])
        XCTAssertEqual(invoice.items.map(\.quantity), [1, 1])
        XCTAssertEqual(invoice.items.map(\.isFee), [false, true])
    }

    func testFourReceiptCorpusIncludesAndDeduplicatesReviewedFees() throws {
        let scenarios: [(total: Decimal, fee: Decimal)] = [
            (Decimal(string: "882.99")!, 12), (433, 10), (229, 9), (895, 15)
        ]
        for scenario in scenarios {
            let product = scenario.total - scenario.fee
            let page = [
                token("Sr.", 10, 900), token("Description", 140, 900, 80), token("Qty", 430, 900), token("Total", 600, 900, 48),
                token("1", 10, 860), token("Corpus product", 140, 860, 100), token("1", 430, 860), token(NSDecimalNumber(decimal: product).stringValue, 600, 860, 55)
            ]
            let feeText = NSDecimalNumber(decimal: scenario.fee).stringValue
            let invoice = try InvoiceParser.parse(text: """
            BLINK COMMERCE
            Invoice Date: 03-Jul-2025
            Invoice Value ₹\(NSDecimalNumber(decimal: scenario.total).stringValue)
            Handling fee ₹\(feeText)
            Annexure tax breakdown
            Handling fee ₹\(feeText)
            """, positionedPages: [page])

            XCTAssertEqual(InvoiceReviewPolicy.itemTotal(invoice.items), scenario.total)
            XCTAssertEqual(invoice.suggestedTotal, scenario.total)
            XCTAssertEqual(invoice.items.filter(\.isFee).count, 1, "annexure fee must not be counted twice")
            XCTAssertEqual(invoice.items.first(where: \.isFee)?.amount, scenario.fee)
        }
    }

    func testReviewedSignedComponentEquationBlocksUnresolvedDifference() {
        let components = [
            ParsedInvoiceItem(name: "Tax-inclusive merchandise", amount: 421, quantity: 1),
            ParsedInvoiceItem(name: "Handling fee", amount: 12, quantity: 1, isFee: true, componentKind: .fee),
            ParsedInvoiceItem(name: "Order coupon", amount: -10, quantity: 1, componentKind: .discount),
            ParsedInvoiceItem(name: "Round off", amount: Decimal(string: "0.01")!, quantity: 1, componentKind: .rounding)
        ]
        XCTAssertEqual(InvoiceReviewPolicy.itemTotal(components), Decimal(string: "423.01"))
        XCTAssertTrue(InvoiceReviewPolicy.reconciles(items: components, finalOrderTotal: Decimal(string: "423.01")))
        XCTAssertFalse(InvoiceReviewPolicy.reconciles(items: components, finalOrderTotal: 433))
        XCTAssertTrue(components.allSatisfy(InvoiceReviewPolicy.validSignedAmount))

        var invalidDiscount = components[2]
        invalidDiscount.amount = 10
        XCTAssertFalse(InvoiceReviewPolicy.validSignedAmount(invalidDiscount))
        var zeroRounding = components[3]
        zeroRounding.amount = 0
        XCTAssertFalse(InvoiceReviewPolicy.validSignedAmount(zeroRounding))
    }

    func testAuthoritativeComponentPayloadCarriesSignedSharedAllocationAndInformationalZero() throws {
        let householdID = UUID(), ektaID = UUID()
        let purchase = Purchase(merchant: "Mixed reviewed order", category: .groceries, paidBy: .ekta)
        let sharedProduct = PurchaseItem(name: "Shared groceries", amount: 200, quantity: 2, unit: "kg", unitPrice: 100, displayOrder: 0)
        let personalProduct = PurchaseItem(name: "Personal snack", amount: 100, displayOrder: 1, isPersonal: true)
        let discount = PurchaseItem(name: "Order coupon", amount: -30, displayOrder: 2, componentKind: .discount)
        discount.sharedLineTotal = -20
        let information = PurchaseItem(name: "UPI tender", amount: 999, displayOrder: 3, componentKind: .informational, includeInTotal: false)
        information.sharedLineTotal = 0
        for item in [sharedProduct, personalProduct, discount, information] { item.purchase = purchase; purchase.items.append(item) }

        let bundle = try SharedDataMapper.purchase(purchase, householdID: householdID, memberIDs: [.ekta: ektaID])
        let payload = try SharedDataMapper.reviewedImport(
            from: bundle, exactPDFHash: String(repeating: "a", count: 64), contentHash: String(repeating: "b", count: 64)
        )
        XCTAssertEqual(payload.amount, 270)
        XCTAssertEqual(bundle.items.map(\.itemKind), ["product", "product", "discount", "informational"])
        XCTAssertEqual(bundle.items.map(\.includeInTotal), [true, true, true, false])
        XCTAssertEqual(bundle.items.map(\.sharedLineTotal), [200, 0, -20, 0])
        XCTAssertEqual(SharedBalanceCalculator.balance(for: ektaID, memberCount: 2, purchases: [bundle], settlements: []), 90)

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: SupabaseJSON.encoder.encode(payload)) as? [String: Any])
        let items = try XCTUnwrap(object["p_items"] as? [[String: Any]])
        XCTAssertEqual(items[2]["item_kind"] as? String, "discount")
        XCTAssertEqual((items[2]["shared_line_total"] as? NSNumber)?.decimalValue, -20)
        XCTAssertEqual(items[3]["include_in_total"] as? Bool, false)
        XCTAssertEqual((items[3]["shared_line_total"] as? NSNumber)?.decimalValue, 0)

        let update = SharedDataMapper.reviewedUpdate(from: bundle)
        let updateObject = try XCTUnwrap(JSONSerialization.jsonObject(with: SupabaseJSON.encoder.encode(update)) as? [String: Any])
        XCTAssertEqual(Set(updateObject.keys), ["p_purchase_id", "p_label", "p_category", "p_purchased_on", "p_items"])
        let updateItems = try XCTUnwrap(updateObject["p_items"] as? [[String: Any]])
        XCTAssertEqual(updateItems[2]["item_kind"] as? String, "discount")
        XCTAssertEqual((updateItems[2]["shared_line_total"] as? NSNumber)?.decimalValue, -20)
        XCTAssertTrue(Set(updateObject.keys).isDisjoint(with: ["pdf", "raw_text", "extracted_text", "file_path", "file_name", "address", "payment_credentials"]))
        XCTAssertEqual(updateItems[0]["unit"] as? String, "kg")
        XCTAssertEqual((updateItems[0]["unit_price"] as? NSNumber)?.decimalValue, 100)
        XCTAssertEqual(ReviewedComponentKind.credit.title, "Order credit")
    }

    func testPaymentTenderAndEmbeddedGSTDoNotChangeFinalObligation() throws {
        let page = [
            token("Sr.", 10, 900), token("Description", 140, 900, 80), token("Qty", 430, 900), token("Total", 600, 900, 48),
            token("1", 10, 860), token("Tax-inclusive product", 140, 860, 120), token("1", 430, 860), token("216.00", 600, 860, 50)
        ]
        let invoice = try InvoiceParser.parse(text: """
        Invoice Date: 03-Jul-2025
        Taxable value 205.71 CGST 5.14 SGST 5.15 Item discount 20
        Handling fee ₹13
        UPI paid ₹100
        Wallet credit applied ₹129
        Cashback earned ₹25
        Amount Paid ₹229
        """, positionedPages: [page])
        XCTAssertEqual(invoice.items.map(\.amount), [216, 13])
        XCTAssertEqual(InvoiceReviewPolicy.itemTotal(invoice.items), 229)
        XCTAssertEqual(invoice.suggestedTotal, 229)
        XCTAssertFalse(invoice.items.contains { $0.name.localizedCaseInsensitiveContains("UPI") || $0.name.localizedCaseInsensitiveContains("GST") || $0.name.localizedCaseInsensitiveContains("cashback") })
    }

    func testDistinctSellerInvoicesAreAdditiveEvenWhenRowNumbersRestart() throws {
        func sellerPage(page: Int, name: String, amount: String) -> [PositionedInvoiceToken] {
            [
                token("Sr.", 10, 900), token("Description", 140, 900, 80), token("Qty", 430, 900), token("Total", 600, 900, 48),
                PositionedInvoiceToken(text: "1", x: 10, y: 860, width: 40, page: page),
                PositionedInvoiceToken(text: name, x: 140, y: 860, width: 120, page: page),
                PositionedInvoiceToken(text: "1", x: 430, y: 860, width: 40, page: page),
                PositionedInvoiceToken(text: amount, x: 600, y: 860, width: 50, page: page)
            ].map { token in var value = token; value.page = page; return value }
        }
        let invoice = try InvoiceParser.parse(
            text: "Invoice Date: 13-Aug-2025\nAmount Payable ₹895",
            positionedPages: [sellerPage(page: 0, name: "Seller A goods", amount: "292"), sellerPage(page: 1, name: "Seller B goods", amount: "603")]
        )
        XCTAssertEqual(invoice.items.map(\.amount), [292, 603])
        XCTAssertEqual(InvoiceReviewPolicy.itemTotal(invoice.items), 895)
        XCTAssertEqual(invoice.suggestedTotal, 895)
    }

    func testReviewedFeeContributesToSharedBalanceButNeverRestock() {
        let receipt = Purchase(merchant: "Receipt with fee", category: .groceries, paidBy: .ekta)
        let product = PurchaseItem(name: "Milk", amount: 200, isTrackedForRestock: true)
        let fee = PurchaseItem(name: "Delivery fee", amount: 20, isTrackedForRestock: true, isFee: true)
        for item in [product, fee] { item.purchase = receipt; receipt.items.append(item) }
        let later = Purchase(merchant: "Later receipt", category: .groceries, purchasedAt: receipt.purchasedAt.addingTimeInterval(86_400), paidBy: .ekta)
        let laterProduct = PurchaseItem(name: "Milk", amount: 210, isTrackedForRestock: true)
        let laterFee = PurchaseItem(name: "Delivery fee", amount: 25, isTrackedForRestock: true, isFee: true)
        for item in [laterProduct, laterFee] { item.purchase = later; later.items.append(item) }

        XCTAssertEqual(LedgerEngine.sharedTotal(for: receipt), 220)
        XCTAssertEqual(LedgerEngine.summary(purchases: [receipt], settlements: []).ekta, 110)
        let suggestions = LedgerEngine.possibleBuys(from: [receipt, later])
        XCTAssertEqual(suggestions.map(\.name), ["Milk"])

        let parsedFee = ParsedInvoiceItem(name: "Platform fee", amount: 5, quantity: 1, isTrackedForRestock: true, isFee: true)
        XCTAssertFalse(InvoiceReviewPolicy.shouldTrackForRestock(item: parsedFee, category: .groceries))
        var personalFee = parsedFee
        personalFee.isPersonal = true
        XCTAssertEqual(InvoiceReviewPolicy.itemTotal([personalFee]), 5, "personal/shared review must not remove the paid fee from receipt amount")
    }

    func testRepeatedProductsAcrossReceiptDatesSurviveFooterLabelNoise() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        let july3 = calendar.date(from: DateComponents(year: 2025, month: 7, day: 3))!
        let august13 = calendar.date(from: DateComponents(year: 2025, month: 8, day: 13))!
        let clean = purchase(name: "Organic Milk", date: july3)
        let noisy = purchase(name: "Organic Milk and other terms and conditions", date: august13)

        let suggestions = LedgerEngine.possibleBuys(from: [noisy, clean], referenceDate: august13)
        XCTAssertEqual(suggestions.count, 1)
        XCTAssertEqual(suggestions.first?.purchaseCount, 2)
        XCTAssertEqual(suggestions.first?.usualIntervalDays, 41)
        XCTAssertEqual(suggestions.first?.lastBought, august13)
    }

    func testPositionedItemDescriptionTablePreservesMultilineSameBrandProducts() throws {
        let page = [
            token("Sr.", 10, 900), token("Description", 140, 900, 80), token("Qty", 430, 900), token("Total", 600, 900, 48),
            token("1", 10, 860), token("Everyday", 140, 860), token("Apple", 140, 851), token("(Pack)", 190, 851), token("2", 430, 860), token("100.00", 600, 860, 48),
            token("2", 10, 820), token("Akshayakalpa", 140, 820, 90), token("Organic", 235, 820), token("Artisanal", 285, 820), token("Organic", 140, 811), token("Set", 190, 811), token("Cup", 220, 811), token("Curd", 250, 811), token("1", 430, 820), token("80.00", 600, 820, 40),
            token("3", 10, 780), token("Akshayakalpa", 140, 780, 90), token("Organic", 235, 780), token("Malai", 140, 771), token("Paneer", 180, 771), token("1", 430, 780), token("145.00", 600, 780, 48)
        ]

        let invoice = try InvoiceParser.parse(text: "Greenmania tax invoice", positionedPages: [page])

        XCTAssertEqual(invoice.items.map(\.name), [
            "Everyday Apple (Pack)",
            "Akshayakalpa Organic Artisanal Organic Set Cup Curd",
            "Akshayakalpa Organic Malai Paneer"
        ])
        XCTAssertEqual(invoice.items.map(\.quantity), [2, 1, 1])
        XCTAssertEqual(invoice.items.map(\.amount), [100, 80, 145])
        XCTAssertEqual(invoice.suggestedTotal, 325, "a contiguous complete Total column may supply the draft total")
    }

    func testPositionedDescriptionOfGoodsUsesQuantityAndRightmostTotalColumns() throws {
        let page = [
            token("Sr.", 10, 550), token("Description", 100, 550, 75), token("Quantity", 330, 550, 55), token("Taxable", 410, 550, 50), token("Total", 560, 550, 45),
            token("1", 10, 510), token("Everyday", 100, 510), token("Apple", 100, 501), token("(Pack)", 145, 501), token("2", 330, 510), token("80.00", 410, 510), token("100.00", 560, 510),
            token("2", 10, 460), token("Organic", 100, 460), token("Milk", 150, 460), token("1", 330, 460), token("50.00", 410, 460), token("65.00", 560, 460)
        ]

        let invoice = try InvoiceParser.parse(text: "Corner invoice\nInvoice Value ₹165.00 reference 14", positionedPages: [page])

        XCTAssertEqual(invoice.items.map { [$0.quantity, $0.amount] }, [[2, 100], [1, 65]])
        XCTAssertEqual(invoice.suggestedTotal, 165)
    }

    func testUnknownReceiptTotalRemainsNilInsteadOfBecomingZero() throws {
        let invoice = try InvoiceParser.parse(text: """
        Corner Shop
        Rice 120.00
        Total Discount 13.00
        """)

        XCTAssertNil(invoice.suggestedTotal)
        XCTAssertNil(InvoiceReviewPolicy.reconciliationDifference(items: invoice.items, invoiceTotal: invoice.suggestedTotal))
        XCTAssertTrue(invoice.note.localizedCaseInsensitiveContains("needs confirmation"))
    }

    func testLabelledButUnreconciledReceiptTotalRemainsUnresolved() throws {
        let invoice = try InvoiceParser.parse(text: """
        Zomato Food Order
        Restaurant Name: Test Kitchen
        Veg Wrap 1 ₹100.00 ₹100.00
        Grand Total items 14 tax 3.54 ₹4,760.00
        """)

        XCTAssertEqual(invoice.items.first?.amount, 100)
        XCTAssertNil(invoice.suggestedTotal)
        XCTAssertNil(InvoiceReviewPolicy.reconciliationDifference(items: invoice.items, invoiceTotal: invoice.suggestedTotal))
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

    func testAuthoritativeRemoteSnapshotRemovesArchivedRecordsButPreservesOutbox() throws {
        let container = try ModelContainer(
            for: Purchase.self, PurchaseItem.self, Settlement.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)
        let archived = Purchase(merchant: "Archived remotely", paidBy: .ekta)
        archived.isRemoteBacked = true
        let staleItem = PurchaseItem(name: "Stale", amount: 200)
        staleItem.purchase = archived; archived.items.append(staleItem)
        context.insert(archived)
        let pending = Purchase(merchant: "Pending local", paidBy: .ritesh)
        pending.needsRemoteSync = true
        pending.exactPDFHash = String(repeating: "a", count: 64)
        pending.contentHash = String(repeating: "b", count: 64)
        context.insert(pending)
        let removedPayment = Settlement(payer: .ritesh, receiver: .ekta, amount: 100)
        removedPayment.isRemoteBacked = true
        removedPayment.receiptAllocations = [.init(purchaseID: archived.id, purchaseItemID: nil, amount: 100)]
        context.insert(removedPayment)
        let pendingPayment = Settlement(payer: .ritesh, receiver: .ekta, amount: 10)
        pendingPayment.needsRemoteSync = true
        pendingPayment.receiptAllocations = [.init(purchaseID: pending.id, purchaseItemID: nil, amount: 10)]
        context.insert(pendingPayment)
        try context.save()

        let householdID = UUID(), ektaID = UUID(), riteshID = UUID()
        let snapshot = RemoteLedgerSnapshot(
            household: .init(id: householdID, name: "Home", archivedAt: nil, purgeAfter: nil),
            memberships: [
                .init(householdID: householdID, userID: ektaID, displayName: "Ekta", role: .owner),
                .init(householdID: householdID, userID: riteshID, displayName: "Ritesh", role: .partner)
            ],
            purchases: [], settlements: [], settlementAllocations: [], supportsReviewedComponentContract: true
        )
        try RemoteLedgerImporter.apply(snapshot, to: context)

        let purchases = try context.fetch(FetchDescriptor<Purchase>())
        let settlements = try context.fetch(FetchDescriptor<Settlement>())
        XCTAssertEqual(purchases.map(\.id), [pending.id])
        XCTAssertEqual(settlements.map(\.id), [pendingPayment.id])
        XCTAssertEqual(LedgerEngine.summary(purchases: purchases, settlements: settlements).ekta, -10)
    }

    func testAuthoritativeSnapshotReconcilesRemovedItemsAndAllocationHistory() throws {
        let container = try ModelContainer(
            for: Purchase.self, PurchaseItem.self, Settlement.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)
        let householdID = UUID(), ektaID = UUID(), riteshID = UUID(), purchaseID = UUID()
        let stale = Purchase(id: purchaseID, merchant: "Old", paidBy: .ekta)
        stale.isRemoteBacked = true
        let keptID = UUID(), removedID = UUID()
        for id in [keptID, removedID] {
            let item = PurchaseItem(id: id, name: "Old item", amount: 100)
            item.purchase = stale; stale.items.append(item)
        }
        context.insert(stale)
        let payment = Settlement(payer: .ritesh, receiver: .ekta, amount: 20)
        payment.isRemoteBacked = true
        payment.receiptAllocations = [.init(purchaseID: purchaseID, purchaseItemID: removedID, amount: 20)]
        context.insert(payment)
        try context.save()

        let remotePurchase = RemotePurchase(
            id: purchaseID, householdID: householdID, label: "Current", category: .groceries,
            amount: 80, paidBy: ektaID, purchasedOn: LedgerDate(.now), createdAt: .now,
            items: [.init(id: keptID, displayOrder: 0, name: "Kept", quantity: 1, unit: "kg", unitPrice: 80, lineTotal: 80, isPersonal: false, isTrackedForRestock: false, estimatedUseBy: nil, itemKind: "product", includeInTotal: true, sharedLineTotal: 80)]
        )
        let snapshot = RemoteLedgerSnapshot(
            household: .init(id: householdID, name: "Home", archivedAt: nil, purgeAfter: nil),
            memberships: [.init(householdID: householdID, userID: ektaID, displayName: "Ekta", role: .owner), .init(householdID: householdID, userID: riteshID, displayName: "Ritesh", role: .partner)],
            purchases: [remotePurchase], settlements: [], settlementAllocations: [], supportsReviewedComponentContract: true
        )
        try RemoteLedgerImporter.apply(snapshot, to: context)
        let current = try XCTUnwrap(context.fetch(FetchDescriptor<Purchase>()).first)
        XCTAssertEqual(current.items.map(\.id), [keptID])
        XCTAssertEqual(current.items.first?.unit, "kg")
        XCTAssertEqual(current.items.first?.unitPrice, 80)
        XCTAssertTrue(try context.fetch(FetchDescriptor<Settlement>()).isEmpty)
        XCTAssertEqual(LedgerEngine.summary(purchases: [current], settlements: []).ekta, 40)
    }

    func testInvoiceFingerprintsAreDistinctAndNormalizedWithoutPersistingIdentifiers() {
        XCTAssertNotEqual(InvoiceFingerprint.sha256(Data("pdf-a".utf8)), InvoiceFingerprint.sha256(Data("pdf-b".utf8)))
        XCTAssertEqual(
            InvoiceFingerprint.contentHash("MILK   ₹80\nOrder #ABC-123"),
            InvoiceFingerprint.contentHash("milk ₹80\norder abc123")
        )
    }

    func testSharedPDFHandoffUsesOpaqueTemporaryNameAndCanBeDiscarded() throws {
        let store = try temporaryPendingDraftStore()
        let source = try temporaryPDF()

        let draft = try store.stagePDF(from: source)

        XCTAssertEqual(draft.url.pathExtension, "pdf")
        XCTAssertEqual(draft.url.deletingPathExtension().lastPathComponent, draft.id.uuidString)
        XCTAssertFalse(draft.url.lastPathComponent.contains("private-invoice-name"))
        XCTAssertEqual(try store.pendingDrafts().map(\.id), [draft.id])

        store.remove(draft)
        XCTAssertTrue(try store.pendingDrafts().isEmpty)
    }

    func testSharedPDFHandoffRejectsNonPDFContent() throws {
        let store = try temporaryPendingDraftStore()
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("not a receipt".utf8).write(to: source)
        addTeardownBlock { try? FileManager.default.removeItem(at: source) }

        XCTAssertThrowsError(try store.stagePDF(from: source)) { error in
            XCTAssertEqual(error as? PendingInvoiceDraftError, .invalidPDF)
        }
        XCTAssertTrue(try store.pendingDrafts().isEmpty)
    }

    func testExpiredSharedPDFDraftIsRemoved() throws {
        let store = try temporaryPendingDraftStore()
        let source = try temporaryPDF()
        let stagedAt = Date(timeIntervalSince1970: 1_000)
        let draft = try store.stagePDF(from: source, now: stagedAt)

        XCTAssertTrue(FileManager.default.fileExists(atPath: draft.url.path))
        XCTAssertTrue(try store.pendingDrafts(now: stagedAt.addingTimeInterval(PendingInvoiceDraftStore.lifetime + 1)).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: draft.url.path))
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
            "p_household_id", "p_paid_by", "p_exact_pdf_hash", "p_content_hash", "p_label",
            "p_category", "p_amount", "p_purchased_on", "p_is_personal", "p_items"
        ])
        let encodedItems = try XCTUnwrap(object["p_items"] as? [[String: Any]])
        let allowedItemKeys: Set<String> = [
            "name", "quantity", "unit", "unit_price", "line_total", "is_personal",
            "is_tracked_for_restock", "estimated_use_by", "display_order", "item_kind", "include_in_total", "shared_line_total"
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

    func testReturningSessionSilentlyRestoresPersistedIdentity() {
        let identity = SessionIdentity(userID: UUID(), email: "ritesh@example.com", lastValidatedAt: Date())
        var machine = ReturningSessionMachine()

        machine.beginRestore(hasStoredSession: true)
        XCTAssertEqual(machine.state, .restoring)
        XCTAssertFalse(machine.state.shouldPresentSignInPrompt)

        machine.finishRestore(.authenticated(identity))
        XCTAssertEqual(machine.state, .authenticated(identity))
        XCTAssertFalse(machine.state.shouldPresentSignInPrompt)
    }

    func testTemporaryRestoreFailureWakesAndRetriesWithoutSignInPrompt() {
        var machine = ReturningSessionMachine()
        machine.beginRestore(hasStoredSession: true)
        machine.finishRestore(.temporarilyUnavailable(.networkUnavailable))

        XCTAssertEqual(machine.state, .waking(SessionWakeState(
            reason: .networkUnavailable,
            retryAttempt: 1,
            lastValidatedIdentity: nil
        )))
        XCTAssertTrue(machine.state.permitsSilentRetry)
        XCTAssertFalse(machine.state.shouldPresentSignInPrompt)

        machine.retry()
        XCTAssertTrue(machine.state.permitsSilentRetry)
        machine.finishRestore(.temporarilyUnavailable(.backendUnavailable))
        XCTAssertEqual(machine.state, .waking(SessionWakeState(
            reason: .backendUnavailable,
            retryAttempt: 2,
            lastValidatedIdentity: nil
        )))
    }

    func testOnlyConfirmedInvalidOrRevokedSessionPromptsSignIn() {
        for reason in [SessionInvalidationReason.invalid, .revoked] {
            var machine = ReturningSessionMachine(state: .restoring)
            machine.finishRestore(.invalid(reason))
            XCTAssertEqual(machine.state, .signInRequired(reason))
            XCTAssertTrue(machine.state.shouldPresentSignInPrompt)
        }

        var firstUse = ReturningSessionMachine()
        firstUse.beginRestore(hasStoredSession: false)
        XCTAssertEqual(firstUse.state, .noStoredSession)
        XCTAssertFalse(firstUse.state.shouldPresentSignInPrompt)
    }

    func testUnconfiguredClientNeverClaimsAuthenticationOrSync() async {
        let client = UnconfiguredSharedLedgerSyncClient()

        await client.restoreSession()
        await client.synchronize()

        XCTAssertEqual(client.sessionState, .localOnly)
        XCTAssertEqual(client.state, .notConfigured)
    }

    func testEmailVerificationCodeAcceptsSixThroughEightDigits() {
        XCTAssertNotNil(EmailVerificationCode("123456"))
        XCTAssertNotNil(EmailVerificationCode("1234567"))
        XCTAssertNotNil(EmailVerificationCode("12345678"))
    }

    func testEmailVerificationCodeRejectsNonNumericAndOutOfRangeValues() {
        XCTAssertNil(EmailVerificationCode("12345"))
        XCTAssertNil(EmailVerificationCode("123456789"))
        XCTAssertNil(EmailVerificationCode("12345a"))
        XCTAssertNil(EmailVerificationCode("123 456"))
    }

    func testInvoiceImportRequiresAvailableProcessingChoiceBeforeFileAccess() {
        var flow = InvoiceImportFlow()
        XCTAssertEqual(flow.phase, .choosingMethod)

        flow.selectedMethod = .privateAI
        XCTAssertFalse(flow.beginFileSelection())
        XCTAssertEqual(flow.phase, .choosingMethod)

        flow.selectedMethod = .local
        XCTAssertTrue(flow.beginFileSelection())
        XCTAssertEqual(flow.phase, .selectingFile(.local))
    }

    func testInvoiceImportMovesFromTransientProcessingToReview() {
        var flow = InvoiceImportFlow()
        XCTAssertTrue(flow.beginFileSelection())
        XCTAssertTrue(flow.beginProcessing())
        XCTAssertEqual(flow.phase, .processing(.local))
        XCTAssertFalse(flow.isReviewing)
        XCTAssertTrue(flow.isProcessing)
        XCTAssertFalse(flow.beginFileSelection(), "processing must reject a second file selection")

        flow.completeProcessing()
        XCTAssertEqual(flow.phase, .reviewing(.local))
        XCTAssertTrue(flow.isReviewing)
        XCTAssertFalse(flow.isProcessing)

        flow.reset()
        XCTAssertEqual(flow.phase, .choosingMethod)
        XCTAssertEqual(flow.selectedMethod, .local)
        XCTAssertFalse(flow.isReviewing)
    }

    func testInvoiceImportFailureReturnsToChoiceWithoutReviewState() {
        var flow = InvoiceImportFlow()
        XCTAssertTrue(flow.beginFileSelection())
        XCTAssertTrue(flow.beginProcessing())
        flow.failProcessing()

        XCTAssertEqual(flow.phase, .choosingMethod)
        XCTAssertFalse(flow.isReviewing)
    }

    func testSettlementEligibilityUsesOnlyActiveSharedOutstandingReceiptsAsOfDate() {
        let old = Purchase(merchant: "Old receipt", purchasedAt: Date(timeIntervalSince1970: 86_400), paidBy: .ekta)
        let shared = PurchaseItem(name: "Shared", amount: 200)
        let personal = PurchaseItem(name: "Personal", amount: 500, isPersonal: true)
        for item in [shared, personal] { item.purchase = old; old.items.append(item) }
        let future = Purchase(merchant: "Future", purchasedAt: Date(timeIntervalSince1970: 864_000), paidBy: .ekta)
        let futureItem = PurchaseItem(name: "Later", amount: 100)
        futureItem.purchase = future; future.items.append(futureItem)
        let prior = Settlement(payer: .ritesh, receiver: .ekta, amount: 40)
        prior.receiptAllocations = [.init(purchaseID: old.id, purchaseItemID: nil, amount: 40)]

        let eligible = LedgerEngine.eligibleReceipts(
            purchases: [old, future], settlements: [prior], receiver: .ekta,
            settledOn: Date(timeIntervalSince1970: 432_000)
        )
        XCTAssertEqual(eligible.count, 1)
        XCTAssertEqual(eligible.first?.purchase.id, old.id)
        XCTAssertEqual(eligible.first?.outstanding, 60)
    }

    func testReceiptBackedSettlementPayloadMatchesRPCAndExcludesReceiptSourceData() throws {
        let payload = ReceiptBackedSettlementRPCPayload(
            householdID: UUID(), receiver: UUID(), amount: 75, settledOn: LedgerDate(.now),
            allocations: [.init(purchaseID: UUID(), purchaseItemID: nil, amount: 75)]
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: SupabaseJSON.encoder.encode(payload)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["p_household_id", "p_receiver", "p_amount", "p_settled_on", "p_allocations"])
        let allocations = try XCTUnwrap(object["p_allocations"] as? [[String: Any]])
        XCTAssertEqual(Set(allocations[0].keys), ["purchase_id", "amount"])
        XCTAssertTrue(Set(object.keys).isDisjoint(with: ["pdf", "raw_text", "file_name", "address", "payment_credentials"]))
    }

    func testLegacyLocalSettlementFallbackRemainsUntilReceiptBackedHistoryExists() {
        let purchase = Purchase(merchant: "Shared", paidBy: .ekta)
        let item = PurchaseItem(name: "Milk", amount: 200)
        item.purchase = purchase; purchase.items.append(item)
        let legacy = Settlement(payer: .ritesh, receiver: .ekta, amount: 25)
        XCTAssertEqual(LedgerEngine.summary(purchases: [purchase], settlements: [legacy]).ekta, 75)

        let backed = Settlement(payer: .ritesh, receiver: .ekta, amount: 10)
        backed.receiptAllocations = [.init(purchaseID: purchase.id, purchaseItemID: nil, amount: 10)]
        XCTAssertEqual(LedgerEngine.summary(purchases: [purchase], settlements: [legacy, backed]).ekta, 90)
        XCTAssertEqual(LedgerEngine.summary(purchases: [], settlements: [backed]).ekta, 0)
    }
}
