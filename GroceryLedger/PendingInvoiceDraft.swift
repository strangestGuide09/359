import Foundation

struct PendingInvoiceDraft: Identifiable, Equatable, Sendable {
    let id: UUID
    let url: URL
    let createdAt: Date
}

enum PendingInvoiceDraftError: LocalizedError, Equatable {
    case appGroupUnavailable
    case invalidPDF
    case fileTooLarge

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable: "The secure Grocery Ledger handoff is unavailable."
        case .invalidPDF: "The shared item is not a readable PDF file."
        case .fileTooLarge: "The shared PDF is too large. Choose a file under 25 MB."
        }
    }
}

struct PendingInvoiceDraftStore: Sendable {
    static let appGroupIdentifier = "group.com.ekta.groceryledger"
    static let lifetime: TimeInterval = 24 * 60 * 60
    static let maximumBytes = 25 * 1_024 * 1_024

    let rootURL: URL

    static func appGroupStore(fileManager: FileManager = .default) throws -> PendingInvoiceDraftStore {
        guard let root = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else { throw PendingInvoiceDraftError.appGroupUnavailable }
        return PendingInvoiceDraftStore(rootURL: root.appendingPathComponent("PendingInvoices", isDirectory: true))
    }

    func stagePDF(from sourceURL: URL, now: Date = .now) throws -> PendingInvoiceDraft {
        try prepareDirectory()
        try cleanupExpired(now: now)

        let attributes = try FileManager.default.attributesOfItem(atPath: sourceURL.path)
        let byteCount = (attributes[.size] as? NSNumber)?.intValue ?? 0
        guard byteCount <= Self.maximumBytes else { throw PendingInvoiceDraftError.fileTooLarge }
        guard try hasPDFSignature(sourceURL) else { throw PendingInvoiceDraftError.invalidPDF }

        let id = UUID()
        let destination = rootURL.appendingPathComponent(id.uuidString).appendingPathExtension("pdf")
        let temporary = rootURL.appendingPathComponent(".\(id.uuidString).incoming")
        try? FileManager.default.removeItem(at: temporary)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.copyItem(at: sourceURL, to: temporary)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: temporary.path
        )
        try FileManager.default.moveItem(at: temporary, to: destination)
        try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: destination.path)
        return PendingInvoiceDraft(id: id, url: destination, createdAt: now)
    }

    func pendingDrafts(now: Date = .now) throws -> [PendingInvoiceDraft] {
        try prepareDirectory()
        try cleanupExpired(now: now)
        let urls = try FileManager.default.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        )
        return urls.compactMap { url in
            guard url.pathExtension.lowercased() == "pdf",
                  let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent),
                  let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                  values.isRegularFile == true else { return nil }
            return PendingInvoiceDraft(id: id, url: url, createdAt: values.contentModificationDate ?? .distantPast)
        }.sorted { $0.createdAt < $1.createdAt }
    }

    func remove(_ draft: PendingInvoiceDraft) {
        try? FileManager.default.removeItem(at: draft.url)
    }

    func removeFile(at url: URL) {
        guard url.deletingLastPathComponent().standardizedFileURL == rootURL.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }

    func cleanupExpired(now: Date = .now) throws {
        guard FileManager.default.fileExists(atPath: rootURL.path) else { return }
        let urls = try FileManager.default.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: []
        )
        for url in urls {
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if now.timeIntervalSince(modified) >= Self.lifetime {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    private func hasPDFSignature(_ url: URL) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try handle.read(upToCount: 5) == Data("%PDF-".utf8)
    }
}
