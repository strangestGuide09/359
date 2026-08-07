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
            ScrollView {
                LazyVStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 10) {
                        BrandEyebrow(text: "Today’s balance")
                        Text(summary.settlementMessage)
                            .font(.title2.bold())
                            .foregroundStyle(.white)
                        Text("Shared purchases are split equally between Ekta and Ritesh.")
                            .font(.caption)
                            .foregroundStyle(Color.white.opacity(0.72))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                    .background {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(GroceryBrand.pine)
                            .shadow(color: GroceryBrand.warmShadow, radius: 0, x: 6, y: 6)
                    }
                    .padding(.bottom, 6)

                    VStack(alignment: .leading, spacing: 14) {
                        BrandEyebrow(text: "Settlements")
                        Text("Payment history").font(.title2.bold())
                        if settlements.isEmpty {
                            BrandEmptyState(icon: "arrow.left.arrow.right", title: "No settlements recorded", message: "Record a payment after one person settles their share.")
                        } else {
                            ForEach(settlements, id: \.id) { settlement in
                                HStack(spacing: 12) {
                                    Image(systemName: "arrow.left.arrow.right.circle.fill")
                                        .font(.title2).foregroundStyle(GroceryBrand.orange)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("\(settlement.payer) paid \(settlement.receiver)").font(.headline)
                                        if !settlement.note.isEmpty { Text(settlement.note).font(.caption).foregroundStyle(GroceryBrand.muted) }
                                    }
                                    Spacer()
                                    Text(settlement.amount, format: .currency(code: "INR"))
                                        .font(.subheadline.bold()).foregroundStyle(GroceryBrand.pine)
                                }
                                .contextMenu {
                                    Button("Delete settlement", systemImage: "trash", role: .destructive) {
                                        modelContext.delete(settlement)
                                    }
                                }
                                if settlement.id != settlements.last?.id { Divider().overlay(GroceryBrand.line) }
                            }
                        }
                    }
                    .brandCard()
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(GroceryBrand.cream)
            .navigationTitle("Balances")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Settle", systemImage: "checkmark.circle") { showSettlement = true } } }
            .sheet(isPresented: $showSettlement) { AddSettlementView() }
            .toolbarBackground(GroceryBrand.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .tint(GroceryBrand.pine)
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
            .brandScreen()
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
