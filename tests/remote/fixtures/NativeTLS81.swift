import Foundation

@main struct NativeTLSChecks {
    static func request(_ url: URL, pin: String) async throws -> Int {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        let session = URLSession(configuration: config, delegate: PinnedSessionDelegate(host: url.host ?? "", fingerprint: pin), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.data(from: url)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }
    static func main() async throws {
        guard CommandLine.arguments.count == 3, let url = URL(string: CommandLine.arguments[1]) else { throw URLError(.badURL) }
        guard try await request(url, pin: CommandLine.arguments[2]) == 200 else { throw URLError(.badServerResponse) }
        var rejected = false
        do { _ = try await request(url, pin: String(repeating: "0", count: 64)) } catch { rejected = true }
        guard rejected else { throw URLError(.serverCertificateUntrusted) }
        print("2 native TLS socket checks passed")
    }
}
