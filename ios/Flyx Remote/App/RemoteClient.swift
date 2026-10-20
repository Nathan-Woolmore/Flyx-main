import Foundation

struct CatalogPage: Decodable, Sendable { let items: [RemoteTitle]; let nextPage: Int? }
struct RemoteDetails: Decodable, Sendable {
    struct Trailer:Decodable,Sendable {let videoID:String;let title:String}
    var trailer:Trailer?
    struct Chapter:Codable,Hashable,Identifiable,Sendable {let id:String;let number:Double;let title:String;let language:String;let edition:String;var editionLabel:String?=nil}
    struct Metadata:Decodable,Identifiable,Sendable {var id:String{label};let label:String;let value:String;var url:String?=nil}
    struct Season: Decodable, Sendable { struct Episode: Decodable, Identifiable, Sendable { var id: Int { number }; let number: Int; let title: String }; let number: Int; let episodes: [Episode] }
    let id: String; let kind: String; let title: String; let overview: String; let posterURL: String?
    let seasons: [Season]; let episodeCount: Int?
    var selectedSeason: Int?
    var seasonError: String?
    var playbackUnavailable:String?
    var rating:Double?
    var voteCount:Int?
    var releaseDate:String?
    var chapterUnavailable:String?
    var chapters:[Chapter]?
    var metadata:[Metadata]?
}
struct PairingRequest: Encodable { let secret: String; let name: String }
struct PairingPending: Decodable { let requestID: String; let status: String }
struct PairingCollect: Encodable { let requestID: String }
struct PairingGrant: Decodable { let status: String; let token: String?; let scopes: [String]?; let deviceID:String? }
struct PlayCommand: Encodable { let id: String; let type: String; let kind: String; let contentID: Int; let season: Int?; let episode: Int?;var seconds:Double? = nil }
struct PlaybackStatus: Decodable, Sendable { let state: String; let position: Double; let duration: Double; var title:String?;var artworkURL:String?;var output:String?;var outputName:String?;var volume:Double?;var isMuted:Bool?;var audioControl:Bool?;var phonePlayback:Bool?;var sourceInfo:PlaybackSourceInfo?;var videoWidth:Int?;var videoHeight:Int? }
struct PlaybackSourceInfo:Decodable,Sendable {
    var origin:String?;var provider:String?;var quality:String?;var qualityBasis:String?;var downloadID:String?;var selection:PhonePlaybackSelection?;var fallback:String?
    var sourceLabel:String {
        if origin=="download"{return "Downloaded on Mac"}
        guard origin=="provider",let provider,!provider.isEmpty else{return "Source unknown"}
        return ["vidsrc":"VidSrc","vidlove":"VidLove","multiembed":"MultiEmbed","videasy":"Videasy","animex":"AnimeX"][provider.lowercased()] ?? provider
    }
    var qualityLabel:String {
        guard let quality,!quality.isEmpty else{return "Quality unknown"}
        if ["auto","unknown"].contains(quality.lowercased()){return quality.lowercased()=="auto" ? "Quality: Auto":"Quality unknown"}
        if quality.lowercased()=="original"{return qualityBasis=="requested" ? "Original (saved label)":"Original advertised"}
        return "\(quality) \(qualityBasis=="requested" ? "requested":"advertised")"
    }
    var fallbackLabel:String? {
        switch fallback {case "local-unavailable":return origin=="download" ? "Previous download unavailable · using another copy":"Download unavailable · using online source";case "source-failed":return "Previous source failed · using fallback";default:return nil}
    }
}
struct PlaybackTransfer:Decodable,Sendable {let position:Double;let paused:Bool}
struct CommandResult: Decodable { let ok: Bool; let status: PlaybackStatus;var transfer:PlaybackTransfer? }
struct RemoteFailure: LocalizedError { let message: String; var status:Int? = nil; var errorDescription: String? { message } }
struct BridgeFailureBody:Decodable {let code:String?}

// Immutable, ephemeral client. No admin cookies, redirects, keychain writes or token persistence.
final class RemoteClient: Sendable {
    private let ownsSession:Bool
    deinit { if ownsSession { session.invalidateAndCancel() } }
    let standalone:StandaloneService?
    var isStandalone:Bool{standalone != nil}
    let baseURL: URL
    private let token: String?
    private let session: URLSession
    let scopes: Set<String>
    private let pinConfigured: Bool
    init(baseURL: URL, token: String? = nil, certificatePin: String = "", scopes: [String] = [], session: URLSession? = nil,standalone:StandaloneService? = nil) {
        ownsSession = session == nil
        self.standalone=standalone; self.baseURL = baseURL; self.token = token; self.scopes=Set(scopes)
        pinConfigured=session != nil || certificatePin.replacingOccurrences(of:":",with:"").range(of:"^[a-fA-F0-9]{64}$",options:.regularExpression) != nil
        if let session { self.session = session } else {
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil; config.urlCredentialStorage = nil
            self.session = URLSession(configuration: config, delegate: PinnedSessionDelegate(host:baseURL.host ?? "",fingerprint:certificatePin), delegateQueue: nil)
        }
    }
    func bytes(_ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        if let standalone{return try await standalone.request(path,query:query,body:body)}
        guard pinConfigured else { throw RemoteFailure(message:"Compare and enter the certificate fingerprint shown on your Mac.") }
        guard baseURL.scheme == "https", baseURL.host?.hasSuffix(".local") == true, baseURL.user == nil, baseURL.password == nil else { throw RemoteFailure(message:"A trusted HTTPS .local Mac address is required.") }
        guard path.hasPrefix("/remote/v1/"), var url = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw RemoteFailure(message: "Invalid Mac endpoint") }
        url.path = path; url.queryItems = query.isEmpty ? nil : query
        guard let endpoint = url.url else { throw RemoteFailure(message: "Invalid Mac endpoint") }
        var request = URLRequest(url: endpoint); request.timeoutInterval = ["/remote/v1/session","/remote/v1/progress","/remote/v1/watchlist","/remote/v1/status"].contains(path) ? 6:30; request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpMethod = "POST"; request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            if (response as? HTTPURLResponse)?.statusCode == 401 { throw RemoteFailure(message: "Pairing expired or access was revoked. Reconnect to your Mac.",status:401) }
            let code=(try? JSONDecoder().decode(BridgeFailureBody.self,from:data))?.code
            if let status=(response as? HTTPURLResponse)?.statusCode,let message=RemoteCompatibility.message(path:path,status:status,code:code){throw RemoteFailure(message:message,status:status)}
            let messages=["WATCHLIST_SCOPE_CHANGED":"The Mac account changed. Watchlist sync will retry.","CAST_CONNECT_FAILED":"The Mac could not connect to the selected TV. Keep it awake on the same network and retry.","CAST_LOAD_FAILED":"The TV could not load this source. Try another source or quality; the original output is retained.","CAST_REQUEST_REJECTED":"The TV rejected the Cast request. Refresh receivers and retry.","CAST_SILENT_UNCONFIRMED":"The TV did not confirm the existing mute and zero-volume policy. No media was loaded.","CAST_READY_TIMEOUT":"The TV connected but did not finish preparing this source in time. The original output is retained.","MAC_RENDERER_TIMEOUT":"The Mac took too long to prepare the destination. Keep Flyx open and retry.","MAC_OPERATION_FAILED":"The Mac could not prepare the current playback source. Reopen its controls and retry.","TRANSFER_DESTINATION_UNCONFIRMED":"The destination did not confirm playback. The original output is retained.","TRANSFER_ORIGIN_CHANGED":"The title or playback session changed. Refresh before switching.","TRANSFER_DESTINATION_CHANGED":"The TV playback session changed. Choose it again.","TRANSFER_ROLLBACK_UNCONFIRMED":"The switch could not be fully restored. Check both outputs before retrying.","TRANSFER_BUSY":"Another playback switch is still in progress. Retry shortly.","TRANSFER_UNSUPPORTED":"This source or destination does not support playback transfer.","PHONE_FORMAT_UNSUPPORTED":"Use compatible MP4 or clear on-demand HLS. Encrypted/DRM streams, live HLS and other containers are unsupported.","PHONE_SOURCE_TIMEOUT":"Streaming sources took too long to prepare. Retry this title.","PHONE_MEDIA_UNAVAILABLE":"The Mac could not prepare this source for the iPhone. Keep it open and retry.","PHONE_MEDIA_EXPIRED":"Phone playback access expired. Prepare the title again from the Mac.","PHONE_TITLE_CHANGED":"The title or episode changed on the Mac. Return to Watch and prepare it again.","PLAYBACK_OUTPUT_CHANGED":"Playback output changed. Refresh the remote before adjusting audio.","PLAYBACK_AUDIO_UNAVAILABLE":"This output did not accept the audio change. Retry from its controls.","PLAYBACK_AUDIO_LOCKED":"Audio changes are locked by the Mac silent playback setting.","MANGA_UNAVAILABLE":"Chapter pages are unavailable. Retry this chapter.","MANGA_EXPIRED":"Reopen this chapter to refresh its page access.","WATCHLIST_PERMISSION_REQUIRED":"Allow watchlist saving for this phone in Flyx on your Mac.","WATCHLIST_ACCOUNT_REQUIRED":"Sign in to Flyx on your Mac to use its watchlist.","WATCHLIST_UNAVAILABLE":"The Mac watchlist is unavailable. Retry shortly.","CATALOG_NOT_FOUND":"This title or season is unavailable. Try another title or retry.","CATALOG_RATE_LIMITED":"The catalogue provider is busy. Wait a moment and retry.","CATALOG_TIMEOUT":"The catalogue provider took too long. Retry this title.","CATALOG_SESSION_REQUIRED":"Open Flyx on your Mac, then retry.","CATALOG_UNAVAILABLE":"The catalogue provider is unavailable. Retry shortly.","CATALOG_INVALID_REQUEST":"That title or season is unavailable. Choose an available season."]
            if let code,let message=messages[code] {throw RemoteFailure(message:message,status:(response as? HTTPURLResponse)?.statusCode)}
            throw RemoteFailure(message: "Mac could not complete the request.",status:(response as? HTTPURLResponse)?.statusCode)
        }
        return data
    }
    func request<T:Decodable>(_ path:String,query:[URLQueryItem]=[],body:Data?=nil)async throws->T {
        let data=try await bytes(path,query:query,body:body)
        do{return try JSONDecoder().decode(T.self,from:data)}catch{throw RemoteFailure(message:path=="/remote/v1/media" ? "Mac returned an incomplete media response. Close and prepare the title again.":"Mac returned incomplete catalogue details. Retry this title.",status:502)}
    }
    func catalog(kind: String, query: String, page: Int = 1) async throws -> CatalogPage {
        try await catalog(CatalogRequest(kind:kind,query:query),page:page)
    }
    func catalog(_ selection:CatalogRequest,page:Int=1) async throws -> CatalogPage { try await request("/remote/v1/catalog",query:selection.queryItems(page:page)) }
    func details(_ title: RemoteTitle, season: Int? = nil) async throws -> RemoteDetails {
        var values=[URLQueryItem(name:"kind",value:title.kind),.init(name:"id",value:title.id)]
        if let season {values.append(.init(name:"season",value:String(season)))}
        return try await request("/remote/v1/details",query:values)
    }
    func play(_ title: RemoteTitle, season: Int?, episode: Int?,seconds:Double?=nil) async throws -> CommandResult {
        guard let id = Int(title.id) else { throw RemoteFailure(message:"This title does not support video playback.") }
        return try await request("/remote/v1/commands",body:JSONEncoder().encode(PlayCommand(id:UUID().uuidString,type:"play",kind:title.kind,contentID:id,season:season,episode:episode,seconds:seconds)))
    }
}
