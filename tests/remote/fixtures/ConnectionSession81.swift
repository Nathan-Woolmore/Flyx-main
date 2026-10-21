import Foundation

struct RemoteFailure: LocalizedError {let message: String; var status: Int? = nil; var errorDescription: String? {message}}
struct PairingRequest: Encodable {let secret: String; let name: String}
struct PairingPending: Decodable {let requestID: String; let status: String}
struct PairingCollect: Encodable {let requestID: String}
struct PairingGrant: Decodable {let status: String; let token: String?; let scopes: [String]?; let deviceID: String?}
struct BridgeInfo: Decodable {let protocolVersion: Int; let name: String}
@MainActor final class RemoteClient {
    let baseURL: URL
    var respond: @MainActor (String) async throws -> Data
    init(baseURL: URL, token: String? = nil, certificatePin: String = "", scopes: [String] = [], respond: @escaping @MainActor (String) async throws -> Data = {_ in throw URLError(.cannotFindHost)}) {self.baseURL = baseURL; self.respond = respond}
    func request<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {try JSONDecoder().decode(T.self, from: await respond(path))}
}
actor ConnectionVerification {static let shared = ConnectionVerification(); func restoredKeychain() {}; func authenticatedSession() {}}
@MainActor final class SeriesReadOnlyVerification {static let shared = SeriesReadOnlyVerification(); func run(client: RemoteClient) async {}}
@MainActor final class CatalogReadOnlyVerification {static let shared = CatalogReadOnlyVerification(); func run(client: RemoteClient) async {}}
final class MemoryConnectionStore: RememberedConnectionStorage {
    var value: RememberedConnection?; var saves = 0
    init(_ value: RememberedConnection?) {self.value = value}
    func load() throws -> RememberedConnection? {value}
    func save(_ value: RememberedConnection) throws {try value.validate(); self.value = value; saves += 1}
    func importPreparedEnrollment() throws {}
}

@main @MainActor struct ConnectionSessionChecks {
    static var passed = 0
    static let instant = Date(timeIntervalSince1970: 1_900_000_000)
    static func check(_ value: Bool, _ name: String) throws {guard value else {throw NSError(domain: "SyntheticConnectionChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: name])}; passed += 1}
    static func json(_ value: [String: Any]) throws -> Data {try JSONSerialization.data(withJSONObject: value)}
    static func code(_ edits: [String: Any] = [:]) throws -> String {
        var value: [String: Any] = ["v":1,"endpoint":"https://new-mac.local:3892","pin":String(repeating:"b",count:64),"secret":String(repeating:"a",count:64),"expiresAt":instant.timeIntervalSince1970*1000+120000]
        value.merge(edits){_,new in new}
        return "FLYX1-" + (try json(value)).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
    }
    static func old() -> RememberedConnection {.init(endpoint:"https://old-mac.local:3892",certificatePin:String(repeating:"c",count:64),token:String(repeating:"SYNTHETIC-OLD",count:5),deviceID:"old-device",scopes:["catalog.read"],pendingApproval:false)}
    static func session(_ store: MemoryConnectionStore) -> RemoteSession {let value=RemoteSession(connectionStore:store);value.now={instant};value.pairingPollDelay = .milliseconds(2);return value}
    static func grant() throws -> Data {try json(["status":"approved","token":String(repeating:"SYNTHETIC-NEW",count:5),"deviceID":"new-device","scopes":["catalog.read","playback.control"]])}
    static func wait(_ condition: @MainActor () -> Bool) async throws {for _ in 0..<300 {if condition(){return};try await Task.sleep(for:.milliseconds(2))};throw URLError(.timedOut)}
    static func main() async throws {
        let valid = try code()
        try check(try ConnectionCode.decode(valid,now:instant).endpoint == "https://new-mac.local:3892","valid complete code")
        try check(try ConnectionCode.decode(valid,now:instant.addingTimeInterval(-5)).v == 1,"small device clock skew does not reject a fresh code")
        for invalid in ["123456",try code(["endpoint":"http://new-mac.local:3892"]),try code(["endpoint":"https://evil.example:3892"]),try code(["endpoint":"https://user@a.local:3892"]),try code(["endpoint":"https://a.local:3892/path"]),try code(["pin":"123456"]),try code(["expiresAt":instant.timeIntervalSince1970*1000+150001])] {
            var refused=false;do{_=try ConnectionCode.decode(invalid,now:instant)}catch{refused=true};try check(refused,"invalid code refused")
        }
        do {_=try ConnectionCode.decode(code(["expiresAt":instant.timeIntervalSince1970*1000]),now:instant);throw URLError(.unknown)}catch ConnectionCode.Failure.expired{passed += 1}
        for status in [401,403,503] {
            let store=MemoryConnectionStore(old()),value=session(store)
            value.checkFixture=RemoteClient(baseURL:URL(string:old().endpoint)!,respond:{_ in throw RemoteFailure(message:"Synthetic unavailable",status:status)})
            await value.restoreAndConnect()
            try check(store.saves==0 && store.value?.deviceID=="old-device" && value.hasPreparedConnection,"failed restoration retains old enrollment")
            if status==403 {try check(value.phase == .waitingForApproval,"pending approval remains explicit")}
            value.beginCodeEntry();try check(value.isEnteringCode && store.value?.deviceID=="old-device","new code entry is available despite old prepared connection")
        }
        do {
            let store=MemoryConnectionStore(old()),value=session(store);var approved=false;var polls=0
            value.checkFixture=RemoteClient(baseURL:URL(string:"https://new-mac.local:3892")!,respond:{route in
                if route.hasSuffix("info"){return try json(["protocolVersion":1,"name":"Synthetic Mac"])}
                if route.hasSuffix("request"){return try json(["requestID":"synthetic-request","status":"awaiting-mac-approval"])}
                polls += 1;return approved ? try grant():try json(["status":"awaiting-mac-approval"])
            })
            value.connectionCode=valid;let operation=Task{await value.connectUsingCode()};try await wait{polls>0}
            try check(store.saves==0 && store.value?.deviceID=="old-device","no replacement before Mac approval")
            approved=true;await operation.value
            try check(store.saves==1 && store.value?.endpoint=="https://new-mac.local:3892" && value.client != nil,"approved new hostname is remembered")
            try check(value.connectionCode.isEmpty && value.pairingSecret.isEmpty,"successful code is cleared from UI memory")
        }
        do {
            let store=MemoryConnectionStore(old()),value=session(store);var pending=false;var cancelled=false
            value.checkFixture=RemoteClient(baseURL:URL(string:"https://new-mac.local:3892")!,respond:{route in
                if route.hasSuffix("info"){return try json(["protocolVersion":1,"name":"Synthetic Mac"])}
                if route.hasSuffix("cancel"){cancelled=true;return try json(["ok":true])}
                if route.hasSuffix("request"){pending=true;return try json(["requestID":"synthetic-request","status":"awaiting-mac-approval"])}
                return try json(["status":"awaiting-mac-approval"])
            })
            value.connectionCode=valid;let operation=Task{await value.connectUsingCode()};try await wait{pending};await Task.yield()
            operation.cancel();value.cancelCodeEntry();await operation.value;try await wait{cancelled}
            try check(store.saves==0 && store.value?.deviceID=="old-device" && value.client==nil && value.phase == .disconnected,"cancel retains remembered Mac and ignores late completion")
            value.checkFixture=RemoteClient(baseURL:URL(string:"https://new-mac.local:3892")!,respond:{route in
                if route.hasSuffix("info"){return try json(["protocolVersion":1,"name":"Synthetic Mac"])}
                if route.hasSuffix("request"){return try json(["requestID":"retry-request","status":"awaiting-mac-approval"])}
                return try grant()
            })
            value.connectionCode=valid;await value.connectUsingCode()
            try check(store.saves==1 && value.client != nil,"retry after cancellation can connect")
        }
        do {
            let store=MemoryConnectionStore(old()),value=session(store)
            value.checkFixture=RemoteClient(baseURL:URL(string:"https://new-mac.local:3892")!,respond:{_ in try? await Task.sleep(for:.milliseconds(80));return try json(["protocolVersion":1,"name":"Late synthetic Mac"])})
            value.connectionCode=valid;let operation=Task{await value.connectUsingCode()};try await Task.sleep(for:.milliseconds(5))
            operation.cancel();value.cancelCodeEntry();await operation.value
            try check(value.client==nil && value.phase == .disconnected && store.saves==0,"late discovery reply cannot reconnect after cancel")
        }
        do {
            let store=MemoryConnectionStore(old()),value=session(store);var clock=instant;var pairRequests=0
            value.now={clock};value.checkFixture=RemoteClient(baseURL:URL(string:"https://new-mac.local:3892")!,respond:{route in
                if route.hasSuffix("info"){clock=clock.addingTimeInterval(121);return try json(["protocolVersion":1,"name":"Synthetic Mac"])}
                pairRequests += 1;throw URLError(.badServerResponse)
            })
            value.connectionCode=valid;await value.connectUsingCode()
            try check(pairRequests==0 && store.saves==0 && value.client==nil,"code expiring during discovery never submits pairing")
        }
        print("\(passed) native connection/session checks passed")
    }
}
