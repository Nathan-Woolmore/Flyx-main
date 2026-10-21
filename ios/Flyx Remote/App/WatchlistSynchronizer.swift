import Foundation
import CryptoKit

struct WatchlistSyncOutcome: Sendable { let message: String }
/// The separate bridge owns paired-Mac transport; the standalone service never receives a Mac credential.
actor WatchlistSynchronizer {
    static let shared = WatchlistSynchronizer()
    private var work: Task<WatchlistSyncOutcome, Never>?
    func cancel() { work?.cancel() }
    func synchronize(_ local: StandaloneService) async -> WatchlistSyncOutcome {
        if let work { return await work.value }
        let task = Task { await self.run(local) }
        work = task
        let result = await task.value
        work = nil
        return result
    }
    private func run(_ local: StandaloneService) async -> WatchlistSyncOutcome {
        do {
            try Task.checkCancellation()
            guard let remembered = try RememberedConnectionStore().load() else { return .init(message: "Saved on iPhone · Pair your Mac to sync") }
            guard !remembered.pendingApproval, let url = URL(string: remembered.endpoint) else { return .init(message: "Saved on iPhone · Mac approval needed") }
            let client = RemoteClient(baseURL: url, token: remembered.token, certificatePin: remembered.certificatePin, scopes: remembered.scopes)
            let session: RestoredSession = try await client.request("/remote/v1/session")
            guard session.deviceID == remembered.deviceID else { throw RemoteFailure(message: "Reconnect your paired Mac to sync watchlists.") }
            let page: WatchlistPage = try await client.request("/remote/v1/watchlist")
            guard let scope = page.syncScope, !scope.isEmpty, scope.count <= 512 else { return .init(message: "Saved on iPhone · Update Flyx on Mac to sync") }
            let target = SHA256.hash(data: Data((remembered.certificatePin.lowercased() + ":" + scope).utf8)).map { String(format: "%02x", $0) }.joined()
            let changes = try await local.prepareWatchlistSync(target: target, remote: page.items)
            guard session.scopes.contains("watchlist.write") || changes.isEmpty else { return .init(message: "Mac titles received · Allow watchlist saving on Mac to send iPhone changes") }
            for change in changes.prefix(8) {
                try Task.checkCancellation()
                let alreadyMatches = page.items.contains { $0.stableID == change.item.stableID } == change.add
                if !alreadyMatches {
                    let mutation = WatchlistMutation(operation: change.add ? "add" : "remove", kind: change.item.kind, id: change.item.id, item: change.item, mutationID: change.mutationID, syncScope: scope)
                    let reply: RemoteOK = try await client.request("/remote/v1/watchlist", body: JSONEncoder().encode(mutation))
                    guard reply.ok else { throw RemoteFailure(message: "The Mac did not confirm the watchlist change.") }
                }
                try Task.checkCancellation()
                try await local.acknowledgeWatchlistChange(change, target: target)
            }
            let updated: WatchlistPage = try await client.request("/remote/v1/watchlist")
            guard updated.syncScope == scope else { throw RemoteFailure(message: "The Mac account changed. Watchlist sync will retry.") }
            try Task.checkCancellation()
            let pending = try await local.receiveWatchlistSync(target: target, remote: updated.items)
            return .init(message: pending == 0 ? "Synced with Mac" : "Syncing with Mac · \(pending) changes waiting")
        } catch is CancellationError { return .init(message: "Saved on iPhone · Sync paused") }
        catch let failure as RemoteFailure where [401,403].contains(failure.status ?? 0) { return .init(message: failure.message) }
        catch { return .init(message: "Saved on iPhone · Waiting for Mac") }
    }
}
