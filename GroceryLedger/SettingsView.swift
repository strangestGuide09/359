import SwiftUI
import UserNotifications

enum RestockNotificationFrequency: String, CaseIterable, Identifiable {
    case off = "Off"
    case daily = "Daily"
    case weekly = "Weekly"

    var id: String { rawValue }
}

struct SettingsView: View {
    @AppStorage("restockNotificationFrequency") private var frequency = RestockNotificationFrequency.off.rawValue
    @AppStorage("restockNotificationTime") private var notificationTime = 32_400.0
    @AppStorage("restockNotificationWeekday") private var weekday = 2
    @State private var statusMessage: String?

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
                    Text("Invoice PDFs are read during import only. Grocery Ledger saves only the reviewed purchase details, not the raw receipt, payment details, address, or payment mode.")
                        .font(.footnote)
                }

                if let statusMessage {
                    Section { Text(statusMessage).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Settings")
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
