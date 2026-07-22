import SwiftUI
import SwiftData
import UniformTypeIdentifiers

struct ImportInvoiceView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query private var purchases: [Purchase]

    @State private var showingFilePicker = false
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
                pdfSection
                if hasImportedPDF {
                    metadataSection
                    itemsSection
                    reconciliationSection
                    privacySection
                }
            }
            .navigationTitle("Review PDF import")
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
                case .success(let url): readPDF(url)
                case .failure(let error): errorMessage = error.localizedDescription
                }
            }
            .alert("Could not import PDF", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "Unknown error")
            }
        }
    }

    private var pdfSection: some View {
        Section("Invoice PDF") {
            Button(hasImportedPDF ? "Choose a different PDF" : "Choose PDF", systemImage: "doc.badge.plus") {
                showingFilePicker = true
            }
            Text(hasImportedPDF
                 ? "The PDF has been read locally. Review every field below before saving."
                 : "Choose a selectable-text Instamart, Blinkit, Hyperpure, or Zomato PDF.")
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
                Text("No invoice total was detected. Confirm the reviewed item total manually.")
                    .foregroundStyle(.orange)
            }
        }
    }

    private var privacySection: some View {
        Section("Privacy and saving") {
            Label("The PDF and its extracted receipt text are not saved.", systemImage: "lock.shield")
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
        } catch {
            errorMessage = error.localizedDescription
        }
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
