import Foundation

struct RemoteTitle: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let title: String
    let overview: String
    let posterURL: String?
    var backdropURL: String? = nil
    var rating: Double? = nil
    var releaseDate: String? = nil
    var voteCount: Int? = nil
    var stableID: String { kind + ":" + id }
}
struct WatchlistPage: Codable, Sendable { let items: [RemoteTitle]; var syncScope: String? = nil }
struct WatchlistMutation: Encodable, Sendable {
    let operation: String; let kind: String; let id: String
    var item: RemoteTitle? = nil
    var mutationID: String? = nil
    var syncScope: String? = nil
}
struct WatchlistChange: Codable, Sendable, Equatable {
    var mutationID = UUID().uuidString
    let add: Bool
    let item: RemoteTitle
}
struct WatchlistReplica: Codable, Sendable {
    var items: [RemoteTitle] = []
    var pending: [WatchlistChange] = []
    mutating func edit(_ item: RemoteTitle, add: Bool) throws {
        guard ["movie", "tv", "anime", "manga"].contains(item.kind), !item.id.isEmpty,
              item.id.count <= 300, item.title.count <= 500 else { throw RemoteFailure(message: "This watchlist title is invalid.") }
        guard !add || items.count < 2000 || items.contains(where: { $0.stableID == item.stableID }), pending.count < 4000 else { throw RemoteFailure(message: "Your watchlist is full. Sync or remove a title first.") }
        pending.removeAll { $0.item.stableID == item.stableID }
        pending.append(.init(add: add, item: item))
        items.removeAll { $0.stableID == item.stableID }
        if add { items.insert(item, at: 0) }
    }
    mutating func reconcile(_ remote: [RemoteTitle]) {
        var next = remote
        for change in pending {
            next.removeAll { $0.stableID == change.item.stableID }
            if change.add { next.insert(change.item, at: 0) }
        }
        var seen = Set<String>()
        items = next.filter { seen.insert($0.stableID).inserted }
    }
}
/// Each paired Mac/account has a separate replica. Switching accounts never uploads the old account's list.
struct WatchlistSyncState: Codable, Sendable {
    var activeTarget: String?
    var unpaired = WatchlistReplica()
    var replicas: [String: WatchlistReplica] = [:]
    init(items: [RemoteTitle] = []) {
        unpaired.items = items
        unpaired.pending = items.map { .init(add: true, item: $0) }
    }
    var current: WatchlistReplica {
        get { activeTarget.flatMap { replicas[$0] } ?? unpaired }
        set { if let activeTarget { replicas[activeTarget] = newValue } else { unpaired = newValue } }
    }
    mutating func bind(_ target: String, remote: [RemoteTitle]) throws -> [WatchlistChange] {
        guard remote.count <= 2000 else { throw RemoteFailure(message: "The Mac watchlist exceeds this iPhone's limit.") }
        if replicas[target] == nil {
            guard replicas.count < 8 else { throw RemoteFailure(message: "Too many saved watchlist accounts on this iPhone.") }
            replicas[target] = activeTarget == nil && replicas.isEmpty ? unpaired : WatchlistReplica()
            if activeTarget == nil { unpaired = WatchlistReplica() }
        }
        activeTarget = target
        current.reconcile(remote)
        return current.pending
    }
    mutating func acknowledge(_ change: WatchlistChange, target: String) {
        // A newer local edit may have arrived while the network request was suspended.
        replicas[target]?.pending.removeAll { $0.mutationID == change.mutationID }
    }
    mutating func receive(_ remote: [RemoteTitle], target: String) {
        guard activeTarget == target else { return }
        current.reconcile(remote)
    }
}
