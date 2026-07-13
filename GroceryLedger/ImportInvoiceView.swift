import SwiftUI
import SwiftData
import UniformTypeIdentifiers

struct ImportInvoiceView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query private var purchases: [Purchase]
    @State private var showingFilePicker = false
    @State private var parsed: ParsedInvoice?
    @State private var errorMessage: String?
    @State private var merchant = ""
    @State private var paidBy: LedgerPerson = .ekta
    @State private var itemAmount = ""
    @State private var parsedItems: [ParsedInvoiceItem] = []
    @State private var isSaving = false

    private var isDuplicate: Bool {
        guard let invoiceNumber = parsed?.invoiceNumber else { return false }
        return purchases.contains { $0.invoiceNumber == invoiceNumber }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Invoice PDF") {
                    Button("Choose PDF", systemImage: "doc.badge.plus") { showingFilePicker = true }
                    if let parsed {
                        LabeledContent("Detected merchant", value: parsed.merchant)
                        LabeledContent("Category", value: parsed.category.rawValue)
                        if let number = parsed.invoiceNumber { LabeledContent("Invoice", value: number) }
                        if let buyer = parsed.buyer { LabeledContent("Invoice buyer", value: buyer.rawValue) }
                        Text(parsed.note).font(.footnote).foregroundStyle(.secondary)
                        if isDuplicate { Label("This invoice appears to have already been imported.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                    } else {
                        Text("Instamart and Blinkit/Zomato Hyperpure PDFs with selectable text are supported first.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Shared purchase") {
                    TextField("Merchant", text: $merchant)
                    Picker("Paid by", selection: $paidBy) {
                        ForEach(LedgerPerson.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Text("All saved items split equally between Ekta and Ritesh. You can mark an item personal later.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if parsedItems.isEmpty {
                    Section("Shared total") {
                        TextField("Amount", text: $itemAmount).keyboardType(.decimalPad)
                    }
                } else {
                    Section("Review products") {
                        ForEach($parsedItems) { $item in
                            Toggle(isOn: $item.isTrackedForRestock) {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(item.name)
                                        Text("Mark only if you want usage tracking")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(item.amount, format: .currency(code: "INR"))
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Import invoice")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { save() }
                        .disabled(isSaving || isDuplicate || merchant.isEmpty || (parsedItems.isEmpty && Decimal(string: itemAmount) == nil))
                }
            }
            .fileImporter(isPresented: $showingFilePicker, allowedContentTypes: [.pdf]) { result in
                switch result {
                case .success(let url): readPDF(url)
                case .failure(let error): errorMessage = error.localizedDescription
                }
            }
            .alert("Could not import PDF", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMessage ?? "Unknown error") }
        }
    }

    private func readPDF(_ url: URL) {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
        do {
            let invoice = try InvoiceParser.parse(url: url)
            parsed = invoice
            merchant = invoice.merchant
            if let buyer = invoice.buyer { paidBy = buyer }
            parsedItems = invoice.items
            if let total = invoice.suggestedTotal { itemAmount = total.description }
        } catch { errorMessage = error.localizedDescription }
    }

    private func save() {
        isSaving = true
        let amount = Decimal(string: itemAmount) ?? 0
        let purchase = Purchase(merchant: merchant, category: parsed?.category ?? .other, invoiceNumber: parsed?.invoiceNumber, purchasedAt: parsed?.date ?? .now, paidBy: paidBy, sourcePDF: nil, parsingNote: parsed?.note)
        let items = parsedItems.isEmpty ? [ParsedInvoiceItem(name: "Groceries", amount: amount, quantity: 1)] : parsedItems
        for parsedItem in items {
            let item = PurchaseItem(name: parsedItem.name, amount: parsedItem.amount, quantity: parsedItem.quantity, isTrackedForRestock: parsedItem.isTrackedForRestock)
            item.purchase = purchase
            purchase.items.append(item)
        }
        modelContext.insert(purchase)
        do {
            try modelContext.save()
            dismiss()
        } catch {
            isSaving = false
            errorMessage = "The purchase could not be saved: \(error.localizedDescription)"
        }
    }

}
