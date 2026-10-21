import Foundation

/// An out-of-band code, never a short numeric password or a replacement for TLS trust.
struct ConnectionCode: Decodable, Sendable {
    let v: Int
    let endpoint: String
    let pin: String
    let secret: String
    let expiresAt: Double

    enum Failure: LocalizedError {
        case invalid, expired
        var errorDescription: String? {
            switch self {
            case .invalid: "Paste the complete connection code from Flyx on your Mac."
            case .expired: "This code expired. Create a new code in Flyx on your Mac."
            }
        }
    }

    static func decode(_ text: String, now: Date = Date()) throws -> ConnectionCode {
        let value = text.filter { !$0.isWhitespace }
        guard value.utf8.count <= 4096, value.hasPrefix("FLYX1-") else { throw Failure.invalid }
        let encoded = String(value.dropFirst(6))
        guard !encoded.isEmpty, encoded.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw Failure.invalid }
        var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let bytes = Data(base64Encoded: base64), bytes.count <= 3072,
              let code = try? JSONDecoder().decode(ConnectionCode.self, from: bytes), code.v == 1,
              let url = URLComponents(string: code.endpoint), url.scheme == "https",
              let host = url.host, host.range(of: "^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}\\.local$", options: .regularExpression) != nil,
              let port = url.port, (1024...65535).contains(port), url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              code.pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              code.secret.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              code.expiresAt.isFinite, code.expiresAt.rounded() == code.expiresAt else { throw Failure.invalid }
        let remaining = code.expiresAt - now.timeIntervalSince1970 * 1000
        guard remaining > 0 else { throw Failure.expired }
        // Allow modest clock skew when the iPhone clock trails the Mac.
        // The Mac still enforces the original two-minute offer lifetime.
        guard remaining <= 150_000 else { throw Failure.invalid }
        return code
    }
}
