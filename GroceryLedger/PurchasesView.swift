import SwiftUI
import SwiftData

struct PurchasesView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Purchase.purchasedAt, order: .reverse) private var purchases: [Purchase]
    @State private var showImporter = false
    @State private var showManualExpense = false

    var body: some View {
        NavigationStack {
            List {
                if purchases.isEmpty {
                    ContentUnavailableView("No purchases", systemImage: "doc.badge.plus", description: Text("Import a grocery invoice PDF to create the first shared purchase."))
                }
                ForEach(purchases, id: \.id) { purchase in
                    NavigationLink {
                        PurchaseDetailView(purchase: purchase)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(purchase.merchant).font(.headline)
                            Text(purchase.category).font(.caption).foregroundStyle(.secondary)
                            Text("Paid by \(purchase.paidBy) • \(purchase.purchasedAt.formatted(date: .abbreviated, time: .omitted))")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Text(LedgerEngine.sharedTotal(for: purchase), format: .currency(code: "INR"))
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                }
                .onDelete { indexes in indexes.map { purchases[$0] }.forEach(modelContext.delete) }
            }
            .navigationTitle("Purchases")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Import PDF", systemImage: "doc.badge.plus") { showImporter = true }
                        Button("Add expense", systemImage: "square.and.pencil") { showManualExpense = true }
                    } label: { Label("Add", systemImage: "plus") }
                }
            }
            .sheet(isPresented: $showImporter) { ImportInvoiceView() }
            .sheet(isPresented: $showManualExpense) { AddExpenseView() }
        }
    }
}

private struct PurchaseDetailView: View {
    @Bindable var purchase: Purchase

    var body: some View {
        List {
            Section("Invoice") {
                LabeledContent("Merchant", value: purchase.merchant)
                LabeledContent("Category", value: purchase.category)
                LabeledContent("Paid by", value: purchase.paidBy)
                if let invoice = purchase.invoiceNumber { LabeledContent("Invoice", value: invoice) }
                if let note = purchase.parsingNote { Text(note).font(.footnote).foregroundStyle(.secondary) }
            }
            Section("Items") {
                ForEach(purchase.items.sorted { lhs, rhs in
                    lhs.displayOrder == rhs.displayOrder
                        ? lhs.id.uuidString < rhs.id.uuidString
                        : lhs.displayOrder < rhs.displayOrder
                }, id: \.id) { item in
                    Toggle(isOn: Binding(get: { item.isPersonal }, set: { item.isPersonal = $0 })) {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(item.name)
                                if item.isPersonal { Text("Personal — excluded from split").font(.caption).foregroundStyle(.orange) }
                                if let useBy = item.estimatedUseBy { Text("Estimated use-by: \(useBy.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Text(item.amount, format: .currency(code: "INR"))
                        }
                    }
                    .tint(.orange)
                }
            }
            Section {
                LabeledContent("Shared total", value: LedgerEngine.sharedTotal(for: purchase).formatted(.currency(code: "INR")))
                LabeledContent("Each person", value: (LedgerEngine.sharedTotal(for: purchase) / 2).formatted(.currency(code: "INR")))
            }
        }
        .navigationTitle("Review purchase")
    }
}

private struct AddExpenseView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var category: ExpenseCategory = .groceries
    @State private var label = ""
    @State private var paidBy: LedgerPerson = .ekta
    @State private var amount = ""
    @State private var date = Date.now
    @State private var includeEstimatedUseBy = false
    @State private var estimatedUseBy = Calendar.current.date(byAdding: .day, value: 7, to: .now) ?? .now

    var body: some View {
        NavigationStack {
            Form {
                Picker("Category", selection: $category) { ForEach(ExpenseCategory.allCases) { Text($0.rawValue).tag($0) } }
                TextField(category == .food ? "Restaurant or order label" : "Bill or purchase label", text: $label)
                Picker("Paid by", selection: $paidBy) { ForEach(LedgerPerson.allCases) { Text($0.rawValue).tag($0) } }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                TextField("Amount", text: $amount).keyboardType(.decimalPad)
                if category == .groceries || category == .household {
                    Toggle("Add estimated use-by", isOn: $includeEstimatedUseBy)
                    if includeEstimatedUseBy { DatePicker("Estimated use-by", selection: $estimatedUseBy, displayedComponents: .date) }
                }
                Text("Expenses are split equally by default. The optional use-by date is your estimate, not a package expiry.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .navigationTitle("Add shared expense")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Decimal(string: amount) == nil) }
            }
        }
    }

    private func save() {
        guard let decimal = Decimal(string: amount), decimal > 0 else { return }
        let purchase = Purchase(merchant: label.trimmingCharacters(in: .whitespacesAndNewlines), category: category, purchasedAt: date, paidBy: paidBy, parsingNote: "Added manually")
        let item = PurchaseItem(name: label.trimmingCharacters(in: .whitespacesAndNewlines), amount: decimal, estimatedUseBy: includeEstimatedUseBy ? estimatedUseBy : nil)
        item.purchase = purchase
        purchase.items.append(item)
        modelContext.insert(purchase)
        dismiss()
    }
}
