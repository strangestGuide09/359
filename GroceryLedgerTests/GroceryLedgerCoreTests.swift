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
