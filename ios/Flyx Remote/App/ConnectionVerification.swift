import Foundation

/// Bounded, local verification of the real connection. Never records addresses,
/// headers, credentials, search text, titles, or response bodies.
actor ConnectionVerification {
    static let shared = ConnectionVerification()
    private struct Launch: Codable {
        let id: String
        let startedAt: Date
        var keychainRestored = false
        var authenticated = false
        var catalogItemCount: Int?
        var homeRows: [String:Int]?
        var homeStaleRows: Int?
    }
    private let launchID = UUID().uuidString
    private var launches: [Launch] = []
    private let file: URL

    private init() {
        file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("connection-verification.json")
        if let bytes = try? Data(contentsOf: file), bytes.count < 16_384,
           let previous = try? JSONDecoder().decode([Launch].self, from: bytes) {
            launches = Array(previous.suffix(3))
        }
        launches.append(Launch(id: launchID, startedAt: Date()))
    }

    func restoredKeychain() { update { $0.keychainRestored = true } }
    func authenticatedSession() { update { $0.authenticated = true } }
    func loadedCatalog(itemCount: Int) { update { $0.catalogItemCount = itemCount } }
    func loadedHome(rows:[String:Int],staleRows:Int) { update { $0.homeRows=rows;$0.homeStaleRows=staleRows;$0.catalogItemCount=rows.values.reduce(0,+) } }

    private func update(_ change: (inout Launch) -> Void) {
        #if !DEBUG
        guard let index = launches.firstIndex(where: { $0.id == launchID }) else { return }
        change(&launches[index])
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(launches)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { /* Verification is ancillary and must not interrupt browsing. */ }
        #endif
    }
}
