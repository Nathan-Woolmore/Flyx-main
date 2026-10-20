import SwiftUI
import Observation
import UIKit

@main
struct FlyxRemoteApp: App {
    var body: some Scene { WindowGroup {
        Group {
        #if DEBUG
        if let index=ProcessInfo.processInfo.arguments.firstIndex(of:"--flyx-ui-fixture"),ProcessInfo.processInfo.arguments.count>index+1 {
            UIOnlyRoot(mode:ProcessInfo.processInfo.arguments[index+1]).preferredColorScheme(.dark).tint(FlyxTheme.accent)
        } else { ApplicationModeRoot().preferredColorScheme(.dark).tint(FlyxTheme.accent) }
        #else
        ApplicationModeRoot().preferredColorScheme(.dark).tint(FlyxTheme.accent)
        #endif
        }.keyboardDismissButton()
    } }
}

// Only the phone's scoped credential is remembered in its own Keychain.
@MainActor @Observable
final class RemoteSession {
    enum Phase: Equatable { case disconnected, checking, needsPairing, waitingForApproval, unavailable(String) }
    var phase: Phase = .disconnected
    var address = ""
    var hostName: String?
    var pairingSecret = ""
    var certificatePin = ""
    var client: RemoteClient?
    var pairing = false
    var hasPreparedConnection = false
    private var restoring = false
    private var generation=UUID()
    func cancelPending(){generation=UUID();pairing=false;if client==nil{phase = .disconnected}}
    private func valid(_ ticket:UUID)->Bool{generation==ticket && !Task.isCancelled}
    #if DEBUG
    @ObservationIgnored var checkFixture:RemoteClient?
    #endif
    private func makeClient(_ url:URL,token:String?=nil,scopes:[String]=[])->RemoteClient{
        #if DEBUG
        if let checkFixture{return checkFixture}
        #endif
        return RemoteClient(baseURL:url,token:token,certificatePin:certificatePin,scopes:scopes)
    }
    private let connectionStore = RememberedConnectionStore()
    func restoreAndConnect() async {
        let ticket=generation
        guard !restoring, client == nil else{return};restoring=true;defer{restoring=false}
        do {
            try connectionStore.importPreparedEnrollment()
            guard var saved=try connectionStore.load() else{return}
            await ConnectionVerification.shared.restoredKeychain()
            guard valid(ticket) else{return}
            hasPreparedConnection=true;address=saved.endpoint;certificatePin=saved.certificatePin
            while valid(ticket) && client == nil {
                guard let url=URL(string:saved.endpoint) else{return}
                phase = saved.pendingApproval ? .waitingForApproval:.checking
                let endpoint=RemoteClient(baseURL:url,token:saved.token,certificatePin:saved.certificatePin,scopes:saved.scopes)
                do {
                    let info:RestoredSession=try await endpoint.request("/remote/v1/session")
                    guard valid(ticket) else{return}
                    guard info.deviceID == saved.deviceID else{throw RemoteFailure(message:"Device identity mismatch")}
                    saved.scopes=info.scopes;saved.pendingApproval=false;try connectionStore.save(saved)
                    await ConnectionVerification.shared.authenticatedSession()
                    guard valid(ticket) else{return}
                    client=RemoteClient(baseURL:url,token:saved.token,certificatePin:saved.certificatePin,scopes:info.scopes)
                    if ProcessInfo.processInfo.arguments.contains("--flyx-verify-series"), let client { Task { await SeriesReadOnlyVerification.shared.run(client:client) } }
                    if ProcessInfo.processInfo.arguments.contains("--flyx-verify-catalogue"), let client {
                        Task { await CatalogReadOnlyVerification.shared.run(client:client) }
                    }
                    return
                } catch let failure as RemoteFailure where failure.status == 401 {
                    guard valid(ticket) else{return};connectionStore.remove();hasPreparedConnection=false;phase = .unavailable("Mac access was revoked or expired. Approve this iPhone again on your Mac.");return
                } catch let failure as RemoteFailure where failure.status == 403 {
                    guard valid(ticket) else{return};phase = .waitingForApproval
                } catch {
                    guard valid(ticket) else{return};phase = .unavailable("Allow Local Network access on this iPhone if prompted. Keep Flyx open on your Mac; reconnecting automatically.")
                }
                try await Task.sleep(for:.seconds(3))
            }
        } catch is CancellationError {} catch {if valid(ticket){phase = .unavailable(error.localizedDescription)}}
    }
    func pair() async {
        let ticket=generation
        guard let url = URL(string:address), pairingSecret.count == 64 else { phase = .unavailable("Enter the pairing secret shown on your Mac."); return }
        pairing = true
        defer { pairing = false }
        do {
            let endpoint = RemoteClient(baseURL:url,certificatePin:certificatePin)
            let pending: PairingPending = try await endpoint.request("/remote/v1/pair/request",body:JSONEncoder().encode(PairingRequest(secret:pairingSecret,name:"Flyx Remote iPhone")))
            guard valid(ticket) else{return}
            let end = Date().addingTimeInterval(115)
            while Date() < end && valid(ticket) {
                try await Task.sleep(for:.seconds(1))
                let grant: PairingGrant = try await endpoint.request("/remote/v1/pair/collect",body:JSONEncoder().encode(PairingCollect(requestID:pending.requestID)))
                guard valid(ticket) else{return}
                if grant.status == "approved", let token=grant.token {
                    let saved=RememberedConnection(endpoint:address,certificatePin:certificatePin,token:token,deviceID:grant.deviceID ?? "",scopes:grant.scopes ?? [],pendingApproval:false)
                    try connectionStore.save(saved)
                    client=RemoteClient(baseURL:url,token:token,certificatePin:certificatePin,scopes:grant.scopes ?? []);pairingSecret="";return }
            }
            throw RemoteFailure(message:"Mac approval timed out. Begin pairing again on your Mac.")
        } catch {if valid(ticket){phase = .unavailable(error.localizedDescription)}}
    }

    func check() async {
        let ticket=generation
        client = nil
        guard var components = URLComponents(string: address),
              components.scheme == "https", let host = components.host,
              host.hasSuffix(".local"), components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            phase = .unavailable("Enter the Mac’s HTTPS .local address. Pairing support must be installed on the Mac first.")
            return
        }
        components.path = "/remote/v1/info"
        guard let url = components.url else { return }
        phase = .checking
        do {
            let endpoint=makeClient(url)
            let info: BridgeInfo = try await endpoint.request("/remote/v1/info")
            guard valid(ticket) else{return}
            guard info.protocolVersion == 1 else { throw URLError(.cannotParseResponse) }
            hostName = info.name
            phase = .needsPairing
        } catch {
            guard valid(ticket) else{return}
            phase = .unavailable("Mac bridge unavailable. Check that Flyx is awake and the candidate bridge is configured. \(error.localizedDescription)")
        }
    }
}
struct BridgeInfo: Decodable { let protocolVersion: Int; let name: String }
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct ConnectionView: View {
    @State private var session = RemoteSession()
    @Environment(\.applicationMode) private var applicationMode
    private var connectionPreview:Bool{
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--flyx-ui-fixture") && (ProcessInfo.processInfo.arguments.contains("connection-mode56") || ProcessInfo.processInfo.arguments.contains("--mode-relaunch57"))
        #else
        false
        #endif
    }
    @FocusState private var addressFocused: Bool
    var body: some View {
        Group { if let client=session.client { RemoteHomeView(client:client) } else { connectionForm } }
            .onAppear{applicationMode?.connection=session}
            .onDisappear{session.cancelPending();if applicationMode?.connection === session{applicationMode?.connection=nil}}
            .task { if !connectionPreview{await session.restoreAndConnect()} }
            .onReceive(NotificationCenter.default.publisher(for:UIApplication.willEnterForegroundNotification)){_ in if !connectionPreview{Task{await session.restoreAndConnect()}}}
    }
    private var connectionForm: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("FLYX").font(.system(size: 48, weight: .black, design: .rounded)).foregroundStyle(FlyxTheme.accent)
                        Text("Your Mac. In reach.").font(.title2.bold())
                        Text("Browse on iPhone. Play on your Mac, or cast through Flyx on your Mac.")
                            .foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Connect your Mac", systemImage: "desktopcomputer").font(.headline)
                        if !session.hasPreparedConnection {
                        TextField("https://your-mac.local:port", text: $session.address)
                            .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never)
                            .autocorrectionDisabled().focused($addressFocused)
                            .padding().background(.quaternary, in: .rect(cornerRadius: 12))
                            .onSubmit { connect() }
                        TextField("Mac certificate fingerprint",text:$session.certificatePin).textInputAutocapitalization(.never).autocorrectionDisabled().font(.caption.monospaced())
                        Text("Compare the fingerprint with the Mac before pairing.").font(.caption).foregroundStyle(.secondary)
                        Button(action: connect) {
                            HStack { if session.phase == .checking { ProgressView() }; Text("Check connection").frame(maxWidth: .infinity) }
                        }.buttonStyle(.borderedProminent).foregroundStyle(FlyxTheme.ink).disabled(session.address.isEmpty || session.phase == .checking)
                        status
                        if session.phase == .needsPairing {
                            SecureField("Pairing secret from Mac",text:$session.pairingSecret).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button(session.pairing ? "Waiting for Mac approval…" : "Request pairing") { Task { await session.pair() } }.disabled(session.pairing || session.pairingSecret.count != 64)
                        }
                        } else {
                            status
                            Text("Your phone connection is prepared. Approve this iPhone in Flyx on your Mac; future connections are remembered securely.").font(.subheadline).foregroundStyle(.secondary)
                        }

                    }.padding(22).background(.thinMaterial, in: .rect(cornerRadius: 22))
                    VStack(alignment: .leading, spacing: 14) {
                        Label("Movies & TV", systemImage: "film")
                        Label("Anime & manga", systemImage: "books.vertical")
                        Label("Mac playback & Cast", systemImage: "play.rectangle.on.rectangle")
                        Label("Mac downloads", systemImage: "arrow.down.circle")
                    }.foregroundStyle(.secondary)
                    Text("Development candidate · Secure remote access must be explicitly enabled on the Mac. Your remembered phone reconnects securely. Access can be revoked on the Mac.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(24)
            }.navigationTitle("Flyx Remote").navigationBarTitleDisplayMode(.inline)
                .toolbar{ToolbarItem(placement:.topBarTrailing){if let applicationMode{Button("App mode"){applicationMode.settings=true}.accessibilityIdentifier("connection.app-mode")}}}
        }
    }
    private func connect() { addressFocused = false; Task { await session.check() } }
    @ViewBuilder private var status: some View {
        switch session.phase {
        case .disconnected: Text("Use the same local network as your Mac.").font(.footnote).foregroundStyle(.secondary)
        case .waitingForApproval: Label("On your Mac: Settings → Security → Flyx Remote → Approve iPhone.",systemImage:"lock.shield").font(.subheadline)
        case .checking: Text("Checking Mac bridge…").font(.footnote)
        case .needsPairing: Label("\(session.hostName ?? "Mac") found. Pairing will require approval on the Mac.", systemImage: "lock").font(.footnote)
        case .unavailable(let message): Text(message).font(.footnote).foregroundStyle(.orange).accessibilityLabel("Connection error: \(message)")
        }
    }
}
