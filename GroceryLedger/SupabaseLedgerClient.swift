import Foundation
import Observation
import Security

enum SupabaseConfiguration {
    static let projectURL = URL(string: "https://yhcucqzikcqrlhgjwywe.supabase.co")!
    static let publishableKey = "sb_publishable_u86CrClAiFcaxFHINCr4Jw_fTFKq7Il"
}

struct SupabaseSession: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let user: SupabaseUser

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case user
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try values.decode(String.self, forKey: .accessToken)
        refreshToken = try values.decode(String.self, forKey: .refreshToken)
        let expiresIn = try values.decodeIfPresent(TimeInterval.self, forKey: .expiresIn) ?? 3600
        expiresAt = .now.addingTimeInterval(expiresIn)
        user = try values.decode(SupabaseUser.self, forKey: .user)
    }

    init(accessToken: String, refreshToken: String, expiresAt: Date, user: SupabaseUser) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.user = user
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(accessToken, forKey: .accessToken)
        try values.encode(refreshToken, forKey: .refreshToken)
        try values.encode(max(0, expiresAt.timeIntervalSinceNow), forKey: .expiresIn)
        try values.encode(user, forKey: .user)
    }
}

struct SupabaseUser: Codable, Equatable, Sendable {
    let id: UUID
    let email: String?
}

struct RemoteHousehold: Codable, Equatable, Sendable {
    let id: UUID
    let name: String
    let archivedAt: Date?
    let purgeAfter: Date?

    enum CodingKeys: String, CodingKey {
        case id, name
        case archivedAt = "archived_at"
        case purgeAfter = "purge_after"
    }
}

struct RemoteMembership: Codable, Equatable, Sendable {
    let householdID: UUID
    let userID: UUID
    let displayName: String
    let role: HouseholdRole

    enum CodingKeys: String, CodingKey {
        case householdID = "household_id"
        case userID = "user_id"
        case displayName = "display_name"
        case role
    }
}

struct RemotePurchase: Codable, Equatable, Sendable {
    let id: UUID
    let householdID: UUID
    let label: String
    let category: ExpenseCategory
    let amount: Decimal
    let paidBy: UUID
    let purchasedOn: LedgerDate
    let createdAt: Date
    let items: [RemotePurchaseItem]

    enum CodingKeys: String, CodingKey {
        case id, label, category, amount
        case householdID = "household_id"
        case paidBy = "paid_by"
        case purchasedOn = "purchased_on"
        case createdAt = "created_at"
        case items = "purchase_items"
    }
}

struct RemotePurchaseItem: Codable, Equatable, Sendable {
    let id: UUID
    let displayOrder: Int
    let name: String
    let quantity: Decimal?
    let lineTotal: Decimal?
    let isPersonal: Bool
    let isTrackedForRestock: Bool
    let estimatedUseBy: LedgerDate?

    enum CodingKeys: String, CodingKey {
        case id, name, quantity
        case displayOrder = "display_order"
        case lineTotal = "line_total"
        case isPersonal = "is_personal"
        case isTrackedForRestock = "is_tracked_for_restock"
        case estimatedUseBy = "estimated_use_by"
    }
}

struct RemoteSettlement: Codable, Equatable, Sendable {
    let id: UUID
    let householdID: UUID
    let payer: UUID
    let receiver: UUID
    let amount: Decimal
    let settledOn: LedgerDate

    enum CodingKeys: String, CodingKey {
        case id, payer, receiver, amount
        case householdID = "household_id"
        case settledOn = "settled_on"
    }
}

struct RemoteLedgerSnapshot: Equatable, Sendable {
    let household: RemoteHousehold
    let memberships: [RemoteMembership]
    let purchases: [RemotePurchase]
    let settlements: [RemoteSettlement]
}

enum NativeSyncStatus: Equatable, Sendable {
    case signedOut
    case restoring
    case awaitingCode(email: String)
    case needsHousehold
    case syncing
    case ready(lastSync: Date)
    case waking(message: String)
    case failed(message: String)
}

enum SupabaseClientError: LocalizedError, Equatable {
    case invalidResponse
    case server(status: Int, message: String)
    case noSession
    case noHousehold

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "The server returned an unreadable response."
        case .server(_, let message): message
        case .noSession: "Sign in is required."
        case .noHousehold: "Create or join a household first."
        }
    }
}

struct KeychainSupabaseSessionStore: Sendable {
    private let service = "com.ekta.groceryledger.supabase"
    private let account = "session"

    func load() throws -> SupabaseSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw SupabaseClientError.invalidResponse }
        return try SupabaseJSON.decoder.decode(SupabaseSession.self, from: data)
    }

    func save(_ session: SupabaseSession) throws {
        let data = try SupabaseJSON.encoder.encode(session)
        let attributes = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw SupabaseClientError.invalidResponse }
        } else if status != errSecSuccess { throw SupabaseClientError.invalidResponse }
    }

    func delete() { SecItemDelete(baseQuery as CFDictionary) }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}

enum SupabaseJSON {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

struct SupabaseLedgerAPI: Sendable {
    var session: URLSession = .shared

    func sendCode(email: String, createAccount: Bool, displayName: String?) async throws {
        var body: [String: Any] = ["email": email, "create_user": createAccount]
        if let displayName, !displayName.isEmpty { body["data"] = ["display_name": displayName] }
        _ = try await request(path: "/auth/v1/otp", method: "POST", body: body, authenticatedBy: nil)
    }

    func verifyCode(email: String, code: EmailVerificationCode) async throws -> SupabaseSession {
        let data = try await request(path: "/auth/v1/verify", method: "POST", body: ["email": email, "token": code.value, "type": "email"], authenticatedBy: nil)
        return try SupabaseJSON.decoder.decode(SupabaseSession.self, from: data)
    }

    func refresh(_ refreshToken: String) async throws -> SupabaseSession {
        let data = try await request(path: "/auth/v1/token?grant_type=refresh_token", method: "POST", body: ["refresh_token": refreshToken], authenticatedBy: nil)
        return try SupabaseJSON.decoder.decode(SupabaseSession.self, from: data)
    }

    func createHousehold(name: String, displayName: String, token: String) async throws {
        _ = try await request(path: "/rest/v1/rpc/create_household", method: "POST", body: ["household_name": name, "p_display_name": displayName], authenticatedBy: token)
    }

    func joinHousehold(code: UUID, displayName: String, token: String) async throws {
        _ = try await request(path: "/rest/v1/rpc/join_household", method: "POST", body: ["code": code.uuidString, "p_display_name": displayName], authenticatedBy: token)
    }

    func loadLedger(userID: UUID, token: String) async throws -> RemoteLedgerSnapshot {
        let membershipData = try await get("/rest/v1/household_members?select=household_id,user_id,display_name,role&user_id=eq.\(userID.uuidString)", token: token)
        let own = try SupabaseJSON.decoder.decode([RemoteMembership].self, from: membershipData)
        guard let membership = own.first else { throw SupabaseClientError.noHousehold }
        let id = membership.householdID.uuidString
        async let householdData = get("/rest/v1/households?select=id,name,archived_at,purge_after&id=eq.\(id)", token: token)
        async let membersData = get("/rest/v1/household_members?select=household_id,user_id,display_name,role&household_id=eq.\(id)", token: token)
        async let purchasesData = get("/rest/v1/purchases?select=id,household_id,label,category,amount,paid_by,purchased_on,created_at,purchase_items(id,display_order,name,quantity,line_total,is_personal,is_tracked_for_restock,estimated_use_by)&household_id=eq.\(id)&archived_at=is.null", token: token)
        async let settlementsData = get("/rest/v1/settlements?select=id,household_id,payer,receiver,amount,settled_on&household_id=eq.\(id)&archived_at=is.null", token: token)
        let households = try SupabaseJSON.decoder.decode([RemoteHousehold].self, from: await householdData)
        guard let household = households.first else { throw SupabaseClientError.noHousehold }
        return try await RemoteLedgerSnapshot(
            household: household,
            memberships: SupabaseJSON.decoder.decode([RemoteMembership].self, from: membersData),
            purchases: SupabaseJSON.decoder.decode([RemotePurchase].self, from: purchasesData),
            settlements: SupabaseJSON.decoder.decode([RemoteSettlement].self, from: settlementsData)
        )
    }

    func importReviewed(_ payload: ReviewedImportRPCPayload, token: String) async throws {
        let body = try JSONSerialization.jsonObject(with: SupabaseJSON.encoder.encode(payload))
        _ = try await request(path: "/rest/v1/rpc/import_reviewed_purchase", method: "POST", body: body, authenticatedBy: token)
    }

    func insertSettlement(_ settlement: SettlementDTO, token: String) async throws {
        let body: [String: Any] = ["id": settlement.id.uuidString, "household_id": settlement.householdID.uuidString,
                                   "payer": settlement.payer.uuidString, "receiver": settlement.receiver.uuidString,
                                   "amount": NSDecimalNumber(decimal: settlement.amount), "settled_on": settlement.settledOn.isoString]
        _ = try await request(path: "/rest/v1/settlements", method: "POST", body: body, authenticatedBy: token)
    }

    private func get(_ path: String, token: String) async throws -> Data {
        try await request(path: path, method: "GET", body: nil, authenticatedBy: token)
    }

    private func request(path: String, method: String, body: Any?, authenticatedBy token: String?) async throws -> Data {
        guard let url = URL(string: path, relativeTo: SupabaseConfiguration.projectURL) else { throw SupabaseClientError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(SupabaseConfiguration.publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SupabaseClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["message"] as? String ?? object?["msg"] as? String ?? "Supabase request failed (\(http.statusCode))."
            throw SupabaseClientError.server(status: http.statusCode, message: message)
        }
        return data
    }
}

@MainActor @Observable
final class SupabaseLedgerController {
    private(set) var status: NativeSyncStatus = .restoring
    private(set) var session: SupabaseSession?
    private(set) var snapshot: RemoteLedgerSnapshot?
    private(set) var snapshotRevision = 0
    private let api: SupabaseLedgerAPI
    private let store: KeychainSupabaseSessionStore

    init(api: SupabaseLedgerAPI = SupabaseLedgerAPI(), store: KeychainSupabaseSessionStore = KeychainSupabaseSessionStore()) {
        self.api = api
        self.store = store
    }

    func restore() async {
        status = .restoring
        do {
            guard let stored = try store.load() else { status = .signedOut; return }
            session = try await api.refresh(stored.refreshToken)
            try store.save(session!)
            await reload()
        } catch let error as SupabaseClientError where error == .noHousehold {
            status = .needsHousehold
        } catch {
            status = isConfirmedInvalid(error) ? .signedOut : .waking(message: "Couldn’t reach the household. Your local ledger remains available; tap Retry when online.")
            if isConfirmedInvalid(error) { store.delete(); session = nil }
        }
    }

    func sendCode(email: String, createAccount: Bool, displayName: String?) async {
        do { try await api.sendCode(email: email, createAccount: createAccount, displayName: displayName); status = .awaitingCode(email: email) }
        catch { status = .failed(message: error.localizedDescription) }
    }

    func verify(email: String, code: String) async {
        guard let code = EmailVerificationCode(code) else { status = .failed(message: "Enter the 6–8 digit email code."); return }
        do { session = try await api.verifyCode(email: email, code: code); try store.save(session!); await reload() }
        catch { status = .failed(message: error.localizedDescription) }
    }

    func createHousehold(name: String, displayName: String) async { await householdAction { try await api.createHousehold(name: name, displayName: displayName, token: $0) } }
    func joinHousehold(code: UUID, displayName: String) async { await householdAction { try await api.joinHousehold(code: code, displayName: displayName, token: $0) } }

    func reload() async {
        guard let session else { status = .signedOut; return }
        status = .syncing
        do {
            snapshot = try await api.loadLedger(userID: session.user.id, token: session.accessToken)
            snapshotRevision += 1
            status = .ready(lastSync: .now)
        } catch let error as SupabaseClientError where error == .noHousehold { status = .needsHousehold }
        catch { status = .waking(message: "Sync is temporarily unavailable. Local data is still usable.") }
    }

    func uploadReviewedPurchase(_ payload: ReviewedImportRPCPayload) async throws {
        guard let session else { throw SupabaseClientError.noSession }
        try await api.importReviewed(payload, token: session.accessToken)
        await reload()
    }

    func uploadSettlement(_ settlement: SettlementDTO) async throws {
        guard let session else { throw SupabaseClientError.noSession }
        try await api.insertSettlement(settlement, token: session.accessToken)
        await reload()
    }

    func signOut() { store.delete(); session = nil; snapshot = nil; status = .signedOut }

    func notePendingUploadFailure(_ message: String) {
        status = .waking(message: "A reviewed local change is waiting to sync. Retry when online. \(message)")
    }

    private func householdAction(_ operation: (String) async throws -> Void) async {
        guard let session else { status = .signedOut; return }
        do { try await operation(session.accessToken); await reload() }
        catch { status = .failed(message: error.localizedDescription) }
    }

    private func isConfirmedInvalid(_ error: Error) -> Bool {
        guard case .server(let status, _) = error as? SupabaseClientError else { return false }
        return status == 400 || status == 401
    }
}
