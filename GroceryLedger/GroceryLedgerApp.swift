import SwiftUI
import SwiftData

@main
struct GroceryLedgerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: [Purchase.self, PurchaseItem.self, Settlement.self])
    }
}

struct ContentView: View {
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
    }
}
