import SwiftUI
import SwiftData
import UniformTypeIdentifiers
import CryptoKit
import PDFKit

enum InvoiceProcessingMethod: String, CaseIterable, Identifiable, Sendable {
    case local = "Local"
    case privateAI = "Private AI"

    var id: String { rawValue }
    var isAvailable: Bool { self == .local }
}

enum InvoiceImportPhase: Equatable, Sendable {
    case choosingMethod
    case selectingFile(InvoiceProcessingMethod)
    case processing(InvoiceProcessingMethod)
    case reviewing(InvoiceProcessingMethod)
}

struct InvoiceImportFlow: Equatable, Sendable {
    var selectedMethod: InvoiceProcessingMethod = .local
    private(set) var phase: InvoiceImportPhase = .choosingMethod

    var isReviewing: Bool {
        if case .reviewing = phase { return true }
        return false
    }

    var isProcessing: Bool {
        if case .processing = phase { return true }
        return false
    }

    mutating func beginFileSelection() -> Bool {
        guard phase == .choosingMethod, selectedMethod.isAvailable else { return false }
        phase = .selectingFile(selectedMethod)
        return true
    }

    mutating func cancelFileSelection() {
        guard case .selectingFile = phase else { return }
        phase = .choosingMethod
    }

    mutating func beginProcessing() -> Bool {
        guard case .selectingFile(let method) = phase, method.isAvailable else { return false }
        phase = .processing(method)
        return true
    }

    mutating func completeProcessing() {
        guard case .processing(let method) = phase else { return }
        phase = .reviewing(method)
    }

    mutating func failProcessing() {
        phase = .choosingMethod
    }

    mutating func reset() {
        selectedMethod = .local
        phase = .choosingMethod
    }
}

struct ImportInvoiceView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(SupabaseLedgerController.self) private var sync

    @State private var showingFilePicker = false
    @State private var flow = InvoiceImportFlow()
    @State private var confirmingStartOver = false
    @State private var errorMessage: String?
    @State private var merchant = ""
    @State private var category: ExpenseCategory = .groceries
    @State private var purchaseDate = Date.now
    @State private var purchaseDateConfirmed = false
    @State private var paidBy: LedgerPerson = .ekta
    @State private var parsedItems: [ParsedInvoiceItem] = []
    @State private var suggestedTotal: Decimal?
    @State private var reviewedFinalTotal: Decimal?
    @State private var parsingNote: String?
    @State private var hasImportedPDF = false
    @State private var isSaving = false
    @State private var pendingSharedDraft: PendingInvoiceDraft?
    @State private var exactPDFHash: String?
    @State private var contentHash: String?

    init(pendingDraft: PendingInvoiceDraft? = nil) {
        _pendingSharedDraft = State(initialValue: pendingDraft)
    }

    private var reviewedTotal: Decimal {
        InvoiceReviewPolicy.itemTotal(parsedItems)
    }

    private var reconciliationDifference: Decimal? {
        InvoiceReviewPolicy.reconciliationDifference(items: parsedItems, invoiceTotal: reviewedFinalTotal)
    }

    private var reconciles: Bool {
        InvoiceReviewPolicy.reconciles(items: parsedItems, finalOrderTotal: reviewedFinalTotal)
    }

    private var isValidDraft: Bool {
        hasImportedPDF &&
            purchaseDateConfirmed &&
            reconciles &&
            (reviewedFinalTotal ?? 0) > 0 &&
            !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !parsedItems.isEmpty &&
            parsedItems.allSatisfy {
                !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                    InvoiceReviewPolicy.validSignedAmount($0) && InvoiceReviewPolicy.validSharedAllocation($0) && $0.quantity > 0
            }
    }

    var body: some View {
        NavigationStack {
            Form {
                if flow.isReviewing {
                    pdfSection
                    metadataSection
                    itemsSection
                    reconciliationSection
                    privacySection
                } else {
                    processingChoiceSection
                    if case .processing = flow.phase { processingSection }
                }
            }
            .brandScreen()
            .listSectionSpacing(14)
            .navigationTitle(flow.isReviewing ? "Review PDF import" : "Import invoice")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancelImport() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { save() }
                        .disabled(isSaving || !isValidDraft)
                }
            }
            .fileImporter(isPresented: $showingFilePicker, allowedContentTypes: [.pdf]) { result in
                switch result {
                case .success(let url):
                    guard flow.beginProcessing() else { return }
                    clearDraft()
                    Task { @MainActor in
                        await Task.yield()
                        readPDF(url)
                    }
                case .failure(let error):
                    flow.cancelFileSelection()
                    errorMessage = error.localizedDescription
                }
            }
            .confirmationDialog("Discard this unsaved draft?", isPresented: $confirmingStartOver, titleVisibility: .visible) {
                Button("Start another import", role: .destructive) {
                    clearDraft()
                    flow.reset()
                }
                Button("Keep reviewing", role: .cancel) {}
            } message: {
                Text("Nothing from this draft has been saved.")
            }
            .alert("Could not import PDF", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "Unknown error")
            }
            .toolbarBackground(GroceryBrand.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .onDisappear { discardPendingSharedPDF() }
        }
    }

    private var processingChoiceSection: some View {
        Section("Choose processing") {
            Picker("Processing method", selection: $flow.selectedMethod) {
                ForEach(InvoiceProcessingMethod.allCases) { method in
                    Text(method.rawValue).tag(method)
                }
            }
            .pickerStyle(.segmented)
            .disabled(flow.isProcessing)

            if flow.selectedMethod == .local {
                Label("Processed entirely on this iPhone", systemImage: "iphone")
                    .foregroundStyle(GroceryBrand.pine)
                Text(pendingSharedDraft == nil
                     ? "Choose a selectable-text invoice. The original PDF and extracted text remain local, and nothing is saved until you review and tap Save."
                     : "A PDF shared with Grocery Ledger is waiting locally. Process it to create an editable draft; nothing is saved until you review and tap Save.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Label("Private AI is coming soon", systemImage: "sparkles")
                    .foregroundStyle(GroceryBrand.orange)
                Text("Private AI is not connected in this build, so no document or derivative will be sent. Choose Local to continue.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Button(localProcessingButtonTitle, systemImage: "doc.badge.plus") {
                beginSelectedImport()
            }
            .disabled(flow.isProcessing || !flow.selectedMethod.isAvailable)
        }
    }

    private var processingSection: some View {
        Section("Processing") {
            HStack(spacing: 12) {
                ProgressView()
                Text("Creating an editable local result…")
            }
            Text("The PDF remains local. Nothing is being saved.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var pdfSection: some View {
        Section("Invoice PDF") {
            Button("Start over with another PDF", systemImage: "arrow.counterclockwise") {
                confirmingStartOver = true
            }
            Text("Processed locally. Review only the result below; the original PDF and extracted text remain transient on this iPhone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let parsingNote {
                Text(parsingNote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var metadataSection: some View {
        Section("Purchase details") {
            TextField("Merchant", text: $merchant)
            Picker("Category", selection: $category) {
                ForEach(ExpenseCategory.allCases) { Text($0.rawValue).tag($0) }
            }
            DatePicker("Purchase date", selection: $purchaseDate, displayedComponents: .date)
                .onChange(of: purchaseDate) { _, _ in purchaseDateConfirmed = true }
            if !purchaseDateConfirmed {
                Label("Purchase date was not found. Choose the date printed on the receipt before saving.", systemImage: "calendar.badge.exclamationmark")
                    .foregroundStyle(.orange)
            }
            Picker("Paid by", selection: $paidBy) {
                ForEach(LedgerPerson.allCases) { Text($0.rawValue).tag($0) }
            }
        }
    }

    private var itemsSection: some View {
        Section {
            ForEach($parsedItems) { $item in
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Item name", text: $item.name)
                        .font(.headline)
                    if item.isFee { Label("Paid fee", systemImage: "receipt").font(.caption).foregroundStyle(.secondary) }
                    Picker("Component", selection: $item.componentKind) {
                        ForEach(ReviewedComponentKind.allCases) { kind in Text(kind.title).tag(kind) }
                    }
                    .onChange(of: item.componentKind) { _, kind in item.setComponentKind(kind) }
                    HStack {
                        TextField("Amount", value: $item.amount, format: .number)
                            .keyboardType(item.componentKind.requiresNegativeAmount || item.componentKind == .rounding ? .numbersAndPunctuation : .decimalPad)
                        TextField("Quantity", value: $item.quantity, format: .number)
                            .keyboardType(.decimalPad)
                    }
                    HStack {
                        TextField("Unit (optional)", text: Binding(
                            get: { item.unit ?? "" },
                            set: { item.unit = $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
                        ))
                        TextField("Unit price", value: $item.unitPrice, format: .number)
                            .keyboardType(.decimalPad)
                    }
                    Picker("Allocation", selection: $item.isPersonal) {
                        Text("Shared").tag(false)
                        Text("Personal").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: item.isPersonal) { _, isPersonal in
                        item.sharedLineTotal = item.includeInTotal ? (isPersonal ? 0 : item.amount) : 0
                        if isPersonal {
                            item.isTrackedForRestock = false
                            item.estimatedUseBy = nil
                        }
                    }
                    if item.includeInTotal && (item.componentKind == .discount || item.componentKind == .credit || item.componentKind == .rounding) {
                        TextField("Shared allocation", value: $item.sharedLineTotal, format: .number)
                            .keyboardType(.numbersAndPunctuation)
                        Text("Choose how much of this signed adjustment changes the shared balance. The remainder is personal.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if item.componentKind == .informational {
                        Text("Shown for review only · contributes ₹0 to total and balance")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if item.componentKind == .credit {
                        Text("An order credit applied at checkout reduces this receipt. A later refund is a separate linked event and is not represented here.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if supportsRestock && !item.isPersonal && item.componentKind.canRestock && !item.isFee {
                        Toggle("Track for restock", isOn: $item.isTrackedForRestock)
                        if item.isTrackedForRestock {
                            Toggle("Add estimated use-by", isOn: Binding(
                                get: { item.estimatedUseBy != nil },
                                set: { enabled in
                                    item.estimatedUseBy = enabled
                                        ? Calendar.current.date(byAdding: .day, value: 7, to: purchaseDate)
                                        : nil
                                }
                            ))
                            if item.estimatedUseBy != nil {
                                DatePicker("Estimated use-by", selection: Binding(
                                    get: { item.estimatedUseBy ?? purchaseDate },
                                    set: { item.estimatedUseBy = $0 }
                                ), displayedComponents: .date)
                            }
                        }
                    }
                }
                .padding(.vertical, 5)
            }
            .onDelete { parsedItems.remove(atOffsets: $0) }

            Button("Add item", systemImage: "plus") {
                parsedItems.append(ParsedInvoiceItem(name: "", amount: 0, quantity: 1))
            }
        } header: {
            Text("Review items")
        } footer: {
            Text("Swipe an incorrect row to remove it. Personal items are saved for reference but excluded from the shared balance and restock suggestions.")
        }
    }

    private var reconciliationSection: some View {
        Section("Total check") {
            LabeledContent("Reviewed signed components", value: money(reviewedTotal))
            TextField("Final amount paid or payable", value: $reviewedFinalTotal, format: .number)
                .keyboardType(.decimalPad)
            if let suggestedTotal { LabeledContent("Final total read from PDF", value: money(suggestedTotal)) }
            if let difference = reconciliationDifference {
                Label {
                    Text(abs(difference) <= Decimal(string: "0.01")!
                         ? "Components reconcile to the final customer obligation."
                         : "Unresolved difference: \(money(difference)). Add or correct a fee, order discount, additive tax, or rounding row. Product prices will not be altered automatically.")
                } icon: {
                    Image(systemName: reconciles ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                }
                .foregroundStyle(reconciles ? .green : .orange)
            } else {
                Text("Confirm the final amount paid or payable. Payment methods and future cashback do not reduce this expense.")
                    .foregroundStyle(.orange)
            }
        }
    }

    private var privacySection: some View {
        Section("Privacy and saving") {
            Label("The PDF and its extracted receipt text are not saved.", systemImage: "lock.shield")
                .foregroundStyle(GroceryBrand.pine)
            Text("Only the fields you reviewed—purchase details, item names, amounts, quantities, allocation, and restock choices—are saved locally. When household sync is added, only these reviewed fields will be eligible to sync.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text("Cancel discards this draft without creating a purchase.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var supportsRestock: Bool {
        category == .groceries || category == .household
    }

    private var localProcessingButtonTitle: String {
        guard flow.selectedMethod == .local else { return "Private AI unavailable" }
        return pendingSharedDraft == nil ? "Choose PDF and process locally" : "Process shared PDF locally"
    }

    private func beginSelectedImport() {
        guard flow.beginFileSelection() else { return }
        guard let pendingSharedDraft else {
            showingFilePicker = true
            return
        }
        guard flow.beginProcessing() else { return }
        clearDraft()
        Task { @MainActor in
            await Task.yield()
            readPDF(pendingSharedDraft.url)
        }
    }

    private func money(_ amount: Decimal) -> String {
        amount.formatted(.currency(code: "INR"))
    }

    private func readPDF(_ url: URL) {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer {
            if didAccess { url.stopAccessingSecurityScopedResource() }
            if pendingSharedDraft?.url == url { discardPendingSharedPDF() }
        }
        do {
            let pdfData = try Data(contentsOf: url)
            exactPDFHash = InvoiceFingerprint.sha256(pdfData)
            guard let document = PDFDocument(data: pdfData) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let transientText = (0..<document.pageCount).compactMap { document.page(at: $0)?.string }.joined(separator: "\n")
            contentHash = InvoiceFingerprint.contentHash(transientText)
            let invoice = try InvoiceParser.parse(url: url)
            merchant = invoice.merchant
            category = invoice.category
            if let parsedDate = invoice.date {
                purchaseDate = parsedDate
                purchaseDateConfirmed = true
            } else {
                purchaseDate = .now
                purchaseDateConfirmed = false
            }
            if let buyer = invoice.buyer { paidBy = buyer }
            suggestedTotal = invoice.suggestedTotal
            reviewedFinalTotal = invoice.suggestedTotal
            parsingNote = invoice.note
            parsedItems = invoice.items
            if parsedItems.isEmpty {
                parsedItems = [ParsedInvoiceItem(
                    name: "Review and name this purchase",
                    amount: invoice.suggestedTotal ?? 0,
                    quantity: 1
                )]
            }
            hasImportedPDF = true
            flow.completeProcessing()
        } catch {
            clearDraft()
            flow.failProcessing()
            errorMessage = error.localizedDescription
        }
    }

    private func cancelImport() {
        discardPendingSharedPDF()
        dismiss()
    }

    private func discardPendingSharedPDF() {
        guard let draft = pendingSharedDraft else { return }
        if let store = try? PendingInvoiceDraftStore.appGroupStore() {
            store.remove(draft)
        }
        pendingSharedDraft = nil
    }

    private func clearDraft() {
        merchant = ""
        category = .groceries
        purchaseDate = .now
        purchaseDateConfirmed = false
        paidBy = .ekta
        parsedItems = []
        suggestedTotal = nil
        reviewedFinalTotal = nil
        parsingNote = nil
        exactPDFHash = nil
        contentHash = nil
        hasImportedPDF = false
        isSaving = false
    }

    private func save() {
        guard isValidDraft else { return }
        isSaving = true
        Task { await validateDuplicateAndSave() }
    }

    @MainActor
    private func validateDuplicateAndSave() async {
        guard let exactPDFHash, let contentHash else {
            isSaving = false; errorMessage = "The receipt fingerprints could not be calculated."; return
        }
        if sync.session != nil, sync.snapshot != nil {
            do {
                let duplicate = try await sync.findInvoiceDuplicate(exactPDFHash: exactPDFHash, contentHash: contentHash)
                guard duplicate.status == .none else {
                    isSaving = false; errorMessage = duplicate.userMessage; return
                }
            } catch {
                isSaving = false
                errorMessage = "Duplicate verification is temporarily unavailable. Retry when online; nothing was saved."
                return
            }
        }
        let purchase = Purchase(
            merchant: merchant.trimmingCharacters(in: .whitespacesAndNewlines),
            category: category,
            purchasedAt: purchaseDate,
            paidBy: paidBy
        )
        for (displayOrder, reviewedItem) in parsedItems.enumerated() {
            let tracksForRestock = InvoiceReviewPolicy.shouldTrackForRestock(item: reviewedItem, category: category)
            let item = PurchaseItem(
                name: reviewedItem.name.trimmingCharacters(in: .whitespacesAndNewlines),
                amount: reviewedItem.amount,
                quantity: reviewedItem.quantity,
                unit: reviewedItem.unit,
                unitPrice: reviewedItem.unitPrice,
                displayOrder: displayOrder,
                isPersonal: reviewedItem.isPersonal,
                isTrackedForRestock: tracksForRestock,
                estimatedUseBy: tracksForRestock ? reviewedItem.estimatedUseBy : nil,
                isFee: reviewedItem.isFee,
                componentKind: reviewedItem.componentKind,
                includeInTotal: true
            )
            item.includeInTotal = reviewedItem.includeInTotal
            item.sharedLineTotal = reviewedItem.includeInTotal
                ? (reviewedItem.sharedLineTotal ?? (reviewedItem.isPersonal ? 0 : reviewedItem.amount)) : 0
            item.purchase = purchase
            purchase.items.append(item)
        }
        modelContext.insert(purchase)
        purchase.exactPDFHash = exactPDFHash
        purchase.contentHash = contentHash
        purchase.needsRemoteSync = true
        do {
            try modelContext.save()
            dismiss()
            Task { await RemoteSyncOutbox.flush(using: sync, context: modelContext) }
        } catch {
            modelContext.delete(purchase)
            isSaving = false
            errorMessage = "The reviewed purchase could not be saved: \(error.localizedDescription)"
        }
    }

}

enum InvoiceFingerprint {
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func contentHash(_ transientExtractedText: String) -> String {
        let lower = transientExtractedText.lowercased()
        let allowed = lower.unicodeScalars.compactMap { scalar -> String? in
            let value = scalar.value
            let keep = (48...57).contains(value) || (97...122).contains(value)
                || value == 46 || value == 44 || value == 8_377 || value == 10 || value == 32
            return keep ? String(scalar) : nil
        }
        let filtered = allowed.joined()
        let normalized = filtered
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.split(separator: " ").joined(separator: " ") }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sha256(Data(normalized.utf8))
    }
}
