import SwiftUI
import UserNotifications

enum RestockNotificationFrequency: String, CaseIterable, Identifiable {
    case off = "Off"
    case daily = "Daily"
    case weekly = "Weekly"

    var id: String { rawValue }
}

struct SettingsView: View {
    @Environment(SupabaseLedgerController.self) private var sync
    @AppStorage("restockNotificationFrequency") private var frequency = RestockNotificationFrequency.off.rawValue
    @AppStorage("restockNotificationTime") private var notificationTime = 32_400.0
    @AppStorage("restockNotificationWeekday") private var weekday = 2
    @State private var statusMessage: String?
    @State private var email = ""
    @State private var verificationCode = ""
    @State private var displayName = ""
    @State private var householdName = ""
    @State private var inviteCode = ""
    @State private var creatingAccount = false

    private var selectedFrequency: Binding<RestockNotificationFrequency> {
        Binding(
            get: { RestockNotificationFrequency(rawValue: frequency) ?? .off },
            set: { frequency = $0.rawValue; updateSchedule() }
        )
    }

    private var selectedTime: Binding<Date> {
        Binding(
            get: { Date(timeIntervalSince1970: notificationTime) },
            set: { notificationTime = $0.timeIntervalSince1970; updateSchedule() }
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        BrandEyebrow(text: "Household settings")
                        Text("Ekta & Ritesh").font(.title2.bold())
                        Text("Local app preferences and privacy controls.")
                            .font(.subheadline).foregroundStyle(GroceryBrand.muted)
                    }
                    .padding(.vertical, 8)
                }
                Section("Restock reminders") {
                    Picker("Frequency", selection: selectedFrequency) {
                        ForEach(RestockNotificationFrequency.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    if selectedFrequency.wrappedValue != .off {
                        DatePicker("Time", selection: selectedTime, displayedComponents: .hourAndMinute)
                        if selectedFrequency.wrappedValue == .weekly {
                            Picker("Day", selection: $weekday) {
                                Text("Sunday").tag(1)
                                Text("Monday").tag(2)
                                Text("Tuesday").tag(3)
                                Text("Wednesday").tag(4)
                                Text("Thursday").tag(5)
                                Text("Friday").tag(6)
                                Text("Saturday").tag(7)
                            }
                            .onChange(of: weekday) { _, _ in updateSchedule() }
                        }
                        Text("The reminder asks you to review possible buys. It does not claim an item is definitely finished.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Privacy") {
                    Label("Only the reviewed ledger", systemImage: "lock.shield.fill")
                        .font(.headline)
                        .foregroundStyle(GroceryBrand.pine)
                    Text("Invoice PDFs are read during import only. Grocery Ledger saves only reviewed purchase details—not the raw receipt, extracted text, payment details, address, or payment mode.")
                        .font(.footnote).foregroundStyle(GroceryBrand.muted)
                }

                Section("Household sync") {
                    syncControls
                }

                if let statusMessage {
                    Section { Text(statusMessage).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .brandScreen()
            .listSectionSpacing(14)
            .navigationTitle("Settings")
            .toolbarBackground(GroceryBrand.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    @ViewBuilder private var syncControls: some View {
        LabeledContent("Status", value: syncStatusLabel)
        switch sync.status {
        case .signedOut, .failed:
            Toggle("Create a new account", isOn: $creatingAccount)
            if creatingAccount { TextField("Your name", text: $displayName) }
            TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
            Button(creatingAccount ? "Create account and send code" : "Send verification code") {
                Task { await sync.sendCode(email: email.trimmingCharacters(in: .whitespacesAndNewlines), createAccount: creatingAccount, displayName: displayName) }
            }
            .disabled(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (creatingAccount && displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            if case .failed(let message) = sync.status { Text(message).font(.footnote).foregroundStyle(.red) }
        case .awaitingCode(let sentEmail):
            Text("Enter the 6–8 digit code sent to \(sentEmail).")
                .font(.footnote).foregroundStyle(GroceryBrand.muted)
            TextField("Verification code", text: $verificationCode).keyboardType(.numberPad)
            Button("Verify code") { Task { await sync.verify(email: sentEmail, code: verificationCode) } }
                .disabled(!EmailVerificationCode.isValid(verificationCode))
        case .needsHousehold:
            TextField("Your name", text: $displayName)
            TextField("Household name", text: $householdName)
            Button("Create two-person household") { Task { await sync.createHousehold(name: householdName, displayName: displayName) } }
                .disabled(displayName.isEmpty || householdName.isEmpty)
            TextField("Partner invite code", text: $inviteCode).textInputAutocapitalization(.never)
            Button("Join household") {
                guard let code = UUID(uuidString: inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
                Task { await sync.joinHousehold(code: code, displayName: displayName) }
            }
            .disabled(displayName.isEmpty || UUID(uuidString: inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)) == nil)
        case .waking(let message):
            Text(message).font(.footnote).foregroundStyle(GroceryBrand.muted)
            Button("Retry sync") { Task { await sync.reload() } }
        case .ready(let lastSync):
            Text("Reviewed purchases, item allocations, settlements, and household membership sync with the website. PDFs and extracted text never upload.")
                .font(.footnote).foregroundStyle(GroceryBrand.muted)
            Text("Last synced \(lastSync.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(GroceryBrand.muted)
            Button("Sync now") { Task { await sync.reload() } }
            Button("Sign out", role: .destructive) { sync.signOut() }
        case .restoring, .syncing:
            HStack { ProgressView(); Text(sync.status == .restoring ? "Restoring session…" : "Syncing reviewed ledger…") }
        }
    }

    private var syncStatusLabel: String {
        switch sync.status {
        case .signedOut: "Sign in required"
        case .restoring: "Restoring"
        case .awaitingCode: "Check email"
        case .needsHousehold: "Household setup"
        case .syncing: "Syncing"
        case .ready: "Connected"
        case .waking: "Retrying"
        case .failed: "Action needed"
        }
    }

    private func updateSchedule() {
        let choice = RestockNotificationFrequency(rawValue: frequency) ?? .off
        let scheduledTime = notificationTime
        let scheduledWeekday = weekday
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            center.removePendingNotificationRequests(withIdentifiers: ["groceryledger-restock-review"])
            guard choice != .off else {
                statusMessage = "Restock reminders are off."
                return
            }
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
                guard granted else {
                    statusMessage = "Notifications were not allowed. You can enable them later in iPhone Settings."
                    return
                }
                let time = Date(timeIntervalSince1970: scheduledTime)
                let hour = Calendar.current.component(.hour, from: time)
                let minute = Calendar.current.component(.minute, from: time)
                var components = DateComponents()
                components.hour = hour
                components.minute = minute
                if choice == .weekly { components.weekday = scheduledWeekday }
                let content = UNMutableNotificationContent()
                content.title = "Review possible buys"
                content.body = "Open Grocery Ledger to review your local restock suggestions."
                content.sound = .default
                let request = UNNotificationRequest(
                    identifier: "groceryledger-restock-review",
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
                )
                try await center.add(request)
                statusMessage = "Reminder scheduled."
            } catch {
                statusMessage = error.localizedDescription
            }
        }
    }
}
