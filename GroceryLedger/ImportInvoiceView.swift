import SwiftUI
import SwiftData
import UniformTypeIdentifiers

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
    @Query private var purchases: [Purchase]

    @State private var showingFilePicker = false
    @State private var flow = InvoiceImportFlow()
    @State private var confirmingStartOver = false
    @State private var errorMessage: String?
    @State private var merchant = ""
    @State private var category: ExpenseCategory = .groceries
    @State private var invoiceNumber = ""
    @State private var purchaseDate = Date.now
    @State private var paidBy: LedgerPerson = .ekta
    @State private var parsedItems: [ParsedInvoiceItem] = []
    @State private var suggestedTotal: Decimal?
    @State private var parsingNote: String?
    @State private var hasImportedPDF = false
    @State private var isSaving = false

    private var isDuplicate: Bool {
        let number = invoiceNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        return !number.isEmpty && purchases.contains { $0.invoiceNumber == number }
    }

    private var reviewedTotal: Decimal {
        InvoiceReviewPolicy.itemTotal(parsedItems)
    }

    private var reconciliationDifference: Decimal? {
        InvoiceReviewPolicy.reconciliationDifference(items: parsedItems, invoiceTotal: suggestedTotal)
    }

    private var isValidDraft: Bool {
        hasImportedPDF &&
            !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !parsedItems.isEmpty &&
            parsedItems.allSatisfy {
                !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                    $0.amount >= 0 && $0.quantity > 0
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
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { save() }
                        .disabled(isSaving || isDuplicate || !isValidDraft)
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
                Text("Choose a selectable-text invoice. The original PDF and extracted text remain local, and nothing is saved until you review and tap Save.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Label("Private AI is coming soon", systemImage: "sparkles")
                    .foregroundStyle(GroceryBrand.orange)
                Text("Private AI is not connected in this build, so no document or derivative will be sent. Choose Local to continue.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Button(flow.selectedMethod == .local ? "Choose PDF and process locally" : "Private AI unavailable", systemImage: "doc.badge.plus") {
                guard flow.beginFileSelection() else { return }
                showingFilePicker = true
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
            TextField("Invoice number (optional)", text: $invoiceNumber)
                .textInputAutocapitalization(.characters)
            DatePicker("Purchase date", selection: $purchaseDate, displayedComponents: .date)
            Picker("Paid by", selection: $paidBy) {
                ForEach(LedgerPerson.allCases) { Text($0.rawValue).tag($0) }
            }
            if isDuplicate {
                Label("This invoice number has already been saved.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
        }
    }

    private var itemsSection: some View {
        Section {
            ForEach($parsedItems) { $item in
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Item name", text: $item.name)
                        .font(.headline)
                    HStack {
                        TextField("Amount", value: $item.amount, format: .number)
                            .keyboardType(.decimalPad)
                        TextField("Quantity", value: $item.quantity, format: .number)
                            .keyboardType(.decimalPad)
                    }
                    Picker("Allocation", selection: $item.isPersonal) {
                        Text("Shared").tag(false)
                        Text("Personal").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: item.isPersonal) { _, isPersonal in
                        if isPersonal {
                            item.isTrackedForRestock = false
                            item.estimatedUseBy = nil
                        }
                    }
                    if supportsRestock && !item.isPersonal {
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
            LabeledContent("Reviewed item total", value: money(reviewedTotal))
            if let suggestedTotal {
                LabeledContent("Total read from PDF", value: money(suggestedTotal))
                if let difference = reconciliationDifference {
                    Label {
                        Text(difference == 0
                             ? "Reviewed items match the PDF total."
                             : "Difference: \(money(difference)). Check discounts, fees, and parsed rows before saving.")
                    } icon: {
                        Image(systemName: difference == 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(difference == 0 ? .green : .orange)
                }
            } else {
                LabeledContent("Receipt total", value: "Needs confirmation")
                Text("Difference unavailable until a payable receipt total is confirmed. Verify every parsed row and amount before saving.")
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

    private func money(_ amount: Decimal) -> String {
        amount.formatted(.currency(code: "INR"))
    }

    private func readPDF(_ url: URL) {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
        do {
            let invoice = try InvoiceParser.parse(url: url)
            merchant = invoice.merchant
            category = invoice.category
            invoiceNumber = invoice.invoiceNumber ?? ""
            purchaseDate = invoice.date
            if let buyer = invoice.buyer { paidBy = buyer }
            suggestedTotal = invoice.suggestedTotal
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

    private func clearDraft() {
        merchant = ""
        category = .groceries
        invoiceNumber = ""
        purchaseDate = .now
        paidBy = .ekta
        parsedItems = []
        suggestedTotal = nil
        parsingNote = nil
        hasImportedPDF = false
        isSaving = false
    }

    private func save() {
        guard isValidDraft else { return }
        isSaving = true
        let number = invoiceNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        let purchase = Purchase(
            merchant: merchant.trimmingCharacters(in: .whitespacesAndNewlines),
            category: category,
            invoiceNumber: number.isEmpty ? nil : number,
            purchasedAt: purchaseDate,
            paidBy: paidBy,
            parsingNote: parsingNote
        )
        for (displayOrder, reviewedItem) in parsedItems.enumerated() {
            let tracksForRestock = InvoiceReviewPolicy.shouldTrackForRestock(item: reviewedItem, category: category)
            let item = PurchaseItem(
                name: reviewedItem.name.trimmingCharacters(in: .whitespacesAndNewlines),
                amount: reviewedItem.amount,
                quantity: reviewedItem.quantity,
                displayOrder: displayOrder,
                isPersonal: reviewedItem.isPersonal,
                isTrackedForRestock: tracksForRestock,
                estimatedUseBy: tracksForRestock ? reviewedItem.estimatedUseBy : nil
            )
            item.purchase = purchase
            purchase.items.append(item)
        }
        modelContext.insert(purchase)
        do {
            try modelContext.save()
            dismiss()
        } catch {
            modelContext.delete(purchase)
            isSaving = false
            errorMessage = "The reviewed purchase could not be saved: \(error.localizedDescription)"
        }
    }
}
