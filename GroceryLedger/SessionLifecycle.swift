import Foundation

/// The authentication lifecycle is deliberately separate from synchronization.
/// A temporarily unreachable backend must never be presented as a signed-out user.
enum ReturningSessionState: Equatable, Sendable {
    /// This build has no remote authentication implementation.
    case localOnly
    /// No prior account exists. Sign-in can be offered without interrupting local use.
    case noStoredSession
    /// A persisted session is being restored without showing sign-in.
    case restoring
    /// The session was accepted by the authentication service.
    case authenticated(SessionIdentity)
    /// The stored session is retained while a temporary failure is retried.
    case waking(SessionWakeState)
    /// Sign-in may be prompted only after the service confirms invalidity/revocation.
    case signInRequired(SessionInvalidationReason)

    var shouldPresentSignInPrompt: Bool {
        if case .signInRequired = self { return true }
        return false
    }

    var permitsSilentRetry: Bool {
        if case .waking = self { return true }
        return false
    }
}

struct SessionIdentity: Equatable, Sendable {
    let userID: UUID
    let email: String
    let lastValidatedAt: Date
}

struct SessionWakeState: Equatable, Sendable {
    enum Reason: Equatable, Sendable {
        case networkUnavailable
        case backendUnavailable
        case rateLimited
    }

    let reason: Reason
    let retryAttempt: Int
    let lastValidatedIdentity: SessionIdentity?
}

enum SessionInvalidationReason: Equatable, Sendable {
    case invalid
    case revoked
}

enum SessionRestorationResult: Equatable, Sendable {
    case authenticated(SessionIdentity)
    case temporarilyUnavailable(SessionWakeState.Reason)
    case invalid(SessionInvalidationReason)
}

/// Future Supabase wiring should persist its opaque session in Keychain through
/// this boundary. Session material must never be stored in UserDefaults or logs.
protocol SecureSessionStore: Sendable {
    func loadSealedSession() async throws -> Data?
    func saveSealedSession(_ session: Data) async throws
    func deleteSealedSession() async throws
}

/// Networking will validate/refresh the opaque session and map transport errors
/// to temporary unavailability. Only an explicit invalid/revoked response may
/// return `.invalid`.
protocol SessionRestoring: Sendable {
    func restore(sealedSession: Data) async -> SessionRestorationResult
}

struct ReturningSessionMachine: Equatable, Sendable {
    private(set) var state: ReturningSessionState

    init(state: ReturningSessionState = .localOnly) {
        self.state = state
    }

    mutating func beginRestore(hasStoredSession: Bool) {
        state = hasStoredSession ? .restoring : .noStoredSession
    }

    mutating func finishRestore(_ result: SessionRestorationResult) {
        switch result {
        case .authenticated(let identity):
            state = .authenticated(identity)
        case .temporarilyUnavailable(let reason):
            let previousIdentity: SessionIdentity?
            let attempt: Int
            if case .waking(let wake) = state {
                previousIdentity = wake.lastValidatedIdentity
                attempt = wake.retryAttempt + 1
            } else if case .authenticated(let identity) = state {
                previousIdentity = identity
                attempt = 1
            } else {
                previousIdentity = nil
                attempt = 1
            }
            state = .waking(SessionWakeState(reason: reason, retryAttempt: attempt, lastValidatedIdentity: previousIdentity))
        case .invalid(let reason):
            state = .signInRequired(reason)
        }
    }

    mutating func retry() {
        // Keep the waking state visible while the async retry runs. If it fails,
        // `finishRestore` increments the attempt without losing prior identity.
        guard case .waking = state else { return }
    }

    mutating func signOut() {
        state = .noStoredSession
    }
}

enum NativeSignInRecommendation {
    static let primary = "Six-digit email code"
    static let guidance = "Send a six-digit email code and verify it inside the app. Do not require the person to leave the app to open a sign-in link."
}
