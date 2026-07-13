import SwiftUI
import SwiftData

struct BalancesView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Purchase.purchasedAt, order: .reverse) private var purchases: [Purchase]
    @Query(sort: \Settlement.settledAt, order: .reverse) private var settlements: [Settlement]
    @State private var showSettlement = false

    private var summary: BalanceSummary { LedgerEngine.summary(purchases: purchases, settlements: settlements) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(summary.settlementMessage).font(.title3.bold())
                }
                Section("Settlement history") {
                    if settlements.isEmpty { Text("No settlements recorded.").foregroundStyle(.secondary) }
                    ForEach(settlements, id: \.id) { settlement in
                        VStack(alignment: .leading) {
                            Text("\(settlement.payer) paid \(settlement.receiver)")
                            Text(settlement.amount, format: .currency(code: "INR"))
                                .font(.subheadline.weight(.semibold))
                            if !settlement.note.isEmpty { Text(settlement.note).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .onDelete { indexes in indexes.map { settlements[$0] }.forEach(modelContext.delete) }
                }
            }
            .navigationTitle("Balances")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Settle", systemImage: "checkmark.circle") { showSettlement = true } } }
            .sheet(isPresented: $showSettlement) { AddSettlementView() }
        }
    }
}

private struct AddSettlementView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var payer: LedgerPerson = .ritesh
    @State private var amount = ""
    @State private var note = ""

    var receiver: LedgerPerson { payer == .ekta ? .ritesh : .ekta }
    var body: some View {
        NavigationStack {
            Form {
                Picker("Paid by", selection: $payer) { ForEach(LedgerPerson.allCases) { Text($0.rawValue).tag($0) } }
                LabeledContent("Received by", value: receiver.rawValue)
                TextField("Amount", text: $amount).keyboardType(.decimalPad)
                TextField("Note (optional)", text: $note)
            }
            .navigationTitle("Record settlement")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(Decimal(string: amount) == nil) }
            }
        }
    }
    private func save() {
        guard let decimal = Decimal(string: amount), decimal > 0 else { return }
        modelContext.insert(Settlement(payer: payer, receiver: receiver, amount: decimal, note: note))
        dismiss()
    }
}
