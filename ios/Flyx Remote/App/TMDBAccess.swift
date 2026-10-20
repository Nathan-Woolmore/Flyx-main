import Foundation

struct TMDBCredential: Codable, Sendable {
    enum Kind: String, Codable, CaseIterable, Identifiable, Sendable {
        case apiKey, readAccessToken
        var id: String { rawValue }
        var label: String { self == .apiKey ? "API key (v3)" : "API Read Access Token" }
    }
    let kind: Kind
    let value: String
    init(kind: Kind, value: String) throws {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned.count <= 4096, !cleaned.contains(where: { $0.isWhitespace || $0.isNewline }) else { throw TMDBAccessError.format(kind) }
        let isKey = cleaned.range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) != nil
        guard kind == .apiKey ? isKey : !isKey && cleaned.count >= 20 else { throw TMDBAccessError.format(kind) }
        self.kind = kind; self.value = cleaned
    }
    static func legacy(_ value: String) -> TMDBCredential? {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let kind: Kind = cleaned.range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) != nil ? .apiKey : .readAccessToken
        return try? TMDBCredential(kind: kind, value: cleaned)
    }
}

enum TMDBAccessError: LocalizedError {
    case format(TMDBCredential.Kind), rejected(TMDBCredential.Kind), rateLimited, unavailable, invalidResponse, network
    var errorDescription: String? {
        switch self {
        case .format(.apiKey): "Enter the 32-character API Key (v3 auth) from TMDB API settings. For the longer token, choose API Read Access Token."
        case .format(.readAccessToken): "Enter the API Read Access Token from TMDB API settings. For a 32-character API key, choose API key (v3)."
        case .rejected(let kind): "TMDB did not accept this \(kind.label). Check the selected credential type and copy the matching value from TMDB API settings."
        case .rateLimited: "TMDB is receiving too many requests. Wait a moment and try again."
        case .unavailable: "TMDB is unavailable or denied this request. Check TMDB service status and your API access."
        case .invalidResponse: "TMDB returned an unexpected response. Try again later."
        case .network: "Could not reach TMDB. Check your internet connection and try again."
        }
    }
}

enum TMDBAccess {
    static func request(path: String, query: [URLQueryItem] = [], credential: TMDBCredential) -> URLRequest {
        var parts = URLComponents(string: "https://api.themoviedb.org/3" + path)!
        var items = query.filter { $0.name != "api_key" }
        if credential.kind == .apiKey { items.append(.init(name: "api_key", value: credential.value)) }
        parts.queryItems = items.isEmpty ? nil : items
        var request = URLRequest(url: parts.url!)
        request.timeoutInterval = 15; request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if credential.kind == .readAccessToken { request.setValue("Bearer " + credential.value, forHTTPHeaderField: "Authorization") }
        return request
    }
    static func load(path: String, query: [URLQueryItem] = [], credential: TMDBCredential, session: URLSession) async throws -> Data {
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request(path: path, query: query, credential: credential)) }
        catch is CancellationError { throw CancellationError() }
        catch { if Task.isCancelled { throw CancellationError() }; throw TMDBAccessError.network }
        guard let http = response as? HTTPURLResponse else { throw TMDBAccessError.invalidResponse }
        switch http.statusCode {
        case 200..<300: break
        case 401: throw TMDBAccessError.rejected(credential.kind)
        case 429: throw TMDBAccessError.rateLimited
        default: throw TMDBAccessError.unavailable
        }
        guard data.count <= 4_194_304, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw TMDBAccessError.invalidResponse }
        if body["success"] as? Bool == false { throw TMDBAccessError.rejected(credential.kind) }
        return data
    }
    static func validate(_ credential: TMDBCredential, session: URLSession) async throws {
        let data = try await load(path: "/authentication", credential: credential, session: session)
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard body?["success"] as? Bool == true else { throw TMDBAccessError.invalidResponse }
    }
    static func validationSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        return URLSession(configuration: config, delegate: TMDBNoRedirects(), delegateQueue: nil)
    }
}
private final class TMDBNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
