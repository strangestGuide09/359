import SwiftUI
import SwiftData

struct BalancesView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Purchase.purchasedAt, order: .reverse) private var purchases: [Purchase]
    @Query(sort: \Settlement.settledAt, order: .reverse) private var settlements: [Settlement]
    @State private var showSettlement = false

    private var summary: BalanceSummary { LedgerEngine.summary(purchases: purchases, settlements: settlements) }
    private var displayedSettlements: [Settlement] {
        guard settlements.contains(where: \.isReceiptBacked) else { return settlements }
        let purchaseIDs = Set(purchases.map(\.id))
        return settlements.filter { LedgerEngine.activeSettlementAmount($0, activePurchaseIDs: purchaseIDs) > 0 }
    }

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
                        if displayedSettlements.isEmpty {
                            BrandEmptyState(icon: "arrow.left.arrow.right", title: "No settlements recorded", message: "Record a payment after one person settles their share.")
                        } else {
                            ForEach(displayedSettlements, id: \.id) { settlement in
                                HStack(spacing: 12) {
                                    Image(systemName: "arrow.left.arrow.right.circle.fill")
                                        .font(.title2).foregroundStyle(GroceryBrand.orange)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("\(settlement.payer) paid \(settlement.receiver)").font(.headline)
                                        if !settlement.note.isEmpty { Text(settlement.note).font(.caption).foregroundStyle(GroceryBrand.muted) }
                                    }
                                    Spacer()
                                    Text(settlements.contains(where: \.isReceiptBacked)
                                         ? LedgerEngine.activeSettlementAmount(settlement, activePurchaseIDs: Set(purchases.map(\.id)))
                                         : settlement.amount,
                                         format: .currency(code: "INR"))
                                        .font(.subheadline.bold()).foregroundStyle(GroceryBrand.pine)
                                }
                                .contextMenu {
                                    Button("Delete settlement", systemImage: "trash", role: .destructive) {
                                        modelContext.delete(settlement)
                                    }
                                }
                                if settlement.id != displayedSettlements.last?.id { Divider().overlay(GroceryBrand.line) }
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
    @Environment(SupabaseLedgerController.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Purchase.purchasedAt) private var purchases: [Purchase]
    @Query(sort: \Settlement.settledAt) private var settlements: [Settlement]
    @State private var payer: LedgerPerson = .ritesh
    @State private var amount = ""
    @State private var note = ""
    @State private var settledOn = Date.now
    @State private var selectedReceipts = Set<UUID>()

    var receiver: LedgerPerson { payer == .ekta ? .ritesh : .ekta }
    var decimalAmount: Decimal? { Decimal(string: amount) }
    var eligible: [(purchase: Purchase, outstanding: Decimal)] {
        LedgerEngine.eligibleReceipts(purchases: purchases, settlements: settlements, receiver: receiver, settledOn: settledOn)
    }
    var allocations: [SettlementAllocation] {
        guard var remaining = decimalAmount, remaining > 0 else { return [] }
        var result: [SettlementAllocation] = []
        for candidate in eligible where selectedReceipts.contains(candidate.purchase.id) && remaining > 0 {
            let applied = min(candidate.outstanding, remaining)
            result.append(.init(purchaseID: candidate.purchase.id, purchaseItemID: nil, amount: applied))
            remaining -= applied
        }
        return remaining == 0 ? result : []
    }
    var body: some View {
        NavigationStack {
            Form {
                LabeledContent("Paid by", value: payer.rawValue)
                LabeledContent("Received by", value: receiver.rawValue)
                TextField("Amount", text: $amount).keyboardType(.decimalPad)
                DatePicker("Payment date", selection: $settledOn, displayedComponents: .date)
                Section("Allocate to shared receipts") {
                    if eligible.isEmpty {
                        Text("No eligible shared receipts are outstanding on this date.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(eligible, id: \.purchase.id) { candidate in
                        Toggle(isOn: Binding(
                            get: { selectedReceipts.contains(candidate.purchase.id) },
                            set: { selected in
                                if selected { selectedReceipts.insert(candidate.purchase.id) }
                                else { selectedReceipts.remove(candidate.purchase.id) }
                            }
                        )) {
                            VStack(alignment: .leading) {
                                Text(candidate.purchase.merchant)
                                Text("Outstanding \(candidate.outstanding, format: .currency(code: "INR")) · \(candidate.purchase.purchasedAt, format: .dateTime.day().month().year())")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if decimalAmount != nil && allocations.isEmpty {
                        Text("Selected receipt balances must cover the full payment amount.")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
                TextField("Note (optional)", text: $note)
            }
            .brandScreen()
            .navigationTitle("Record settlement")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(allocations.isEmpty) }
            }
            .onAppear {
                guard let userID = sync.session?.user.id,
                      let memberships = sync.snapshot?.memberships else { return }
                payer = RemoteLedgerImporter.personMap(memberships)[userID] ?? payer
            }
        }
    }
    private func save() {
        guard let decimal = Decimal(string: amount), decimal > 0 else { return }
        let settlement = Settlement(payer: payer, receiver: receiver, amount: decimal, settledAt: settledOn, note: note)
        settlement.receiptAllocations = allocations
        settlement.needsRemoteSync = true
        modelContext.insert(settlement)
        try? modelContext.save()
        dismiss()
        Task { await RemoteSyncOutbox.flush(using: sync, context: modelContext) }
    }
}
