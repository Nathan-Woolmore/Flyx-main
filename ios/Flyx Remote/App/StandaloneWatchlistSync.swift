import Foundation

extension StandaloneService {
    func prepareWatchlistSync(target: String, remote: [RemoteTitle]) throws -> [WatchlistChange] {
        let previous = watchlistSync
        do { let pending = try watchlistSync.bind(target, remote: remote); try persist(); return pending }
        catch { watchlistSync = previous; throw error }
    }
    func acknowledgeWatchlistChange(_ change: WatchlistChange, target: String) throws {
        let previous = watchlistSync
        do { watchlistSync.acknowledge(change, target: target); try persist() }
        catch { watchlistSync = previous; throw error }
    }
    func receiveWatchlistSync(target: String, remote: [RemoteTitle]) throws -> Int {
        guard remote.count <= 2000 else { throw RemoteFailure(message: "The Mac watchlist exceeds this iPhone's limit.") }
        let previous = watchlistSync
        do { watchlistSync.receive(remote, target: target); try persist(); return watchlistSync.current.pending.count }
        catch { watchlistSync = previous; throw error }
    }
}
