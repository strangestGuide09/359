import SwiftUI
import SwiftData

@main
struct GroceryLedgerApp: App {
    @State private var sync = SupabaseLedgerController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(sync)
        }
        .modelContainer(for: [Purchase.self, PurchaseItem.self, Settlement.self])
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(SupabaseLedgerController.self) private var sync
    @Environment(\.modelContext) private var modelContext
    @State private var pendingInvoiceDraft: PendingInvoiceDraft?

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Home", systemImage: "house") }
            PurchasesView()
                .tabItem { Label("Purchases", systemImage: "doc.text") }
            BalancesView()
                .tabItem { Label("Balances", systemImage: "indianrupeesign.circle") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(GroceryBrand.orange)
        .toolbarBackground(GroceryBrand.paper, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .task {
            refreshPendingInvoiceDraft()
            await sync.restore()
            applyRemoteSnapshot()
            await RemoteSyncOutbox.flush(using: sync, context: modelContext)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                refreshPendingInvoiceDraft()
                Task {
                    await sync.reload()
                    applyRemoteSnapshot()
                    await RemoteSyncOutbox.flush(using: sync, context: modelContext)
                }
            }
        }
        .onChange(of: sync.snapshotRevision) { _, _ in applyRemoteSnapshot() }
        .sheet(item: $pendingInvoiceDraft, onDismiss: refreshPendingInvoiceDraft) { draft in
            ImportInvoiceView(pendingDraft: draft)
        }
    }

    private func refreshPendingInvoiceDraft() {
        guard pendingInvoiceDraft == nil,
              let store = try? PendingInvoiceDraftStore.appGroupStore() else { return }
        pendingInvoiceDraft = try? store.pendingDrafts().first
    }

    private func applyRemoteSnapshot() {
        guard let snapshot = sync.snapshot else { return }
        try? RemoteLedgerImporter.apply(snapshot, to: modelContext)
    }
}
