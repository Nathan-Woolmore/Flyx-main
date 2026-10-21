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
    var connectionCode = ""
    var isEnteringCode = false
    var client: RemoteClient?
    var pairing = false
    var hasPreparedConnection = false
    private var codeExpiresAt: Date?
    private var generation = UUID()
    private struct PendingPairing { let endpoint: RemoteClient; let id: String; let secret: String }
    @ObservationIgnored private var pendingPairing: PendingPairing?
    private let connectionStore: any RememberedConnectionStorage
    @ObservationIgnored var now: () -> Date = Date.init
    #if DEBUG
    @ObservationIgnored var checkFixture: RemoteClient?
    @ObservationIgnored var pairingPollDelay: Duration = .seconds(1)
    #endif

    init(connectionStore: any RememberedConnectionStorage = RememberedConnectionStore()) { self.connectionStore = connectionStore }
    func cancelPending() {
        generation = UUID(); pairing = false
        if let pendingPairing { Task { await cancelRequest(pendingPairing) } }
        pendingPairing = nil
        if client == nil { phase = .disconnected }
    }
    private func cancelRequest(_ pending: PendingPairing) async {
        struct Cancellation: Encodable { let requestID: String; let secret: String }
        let _: [String: Bool]? = try? await pending.endpoint.request("/remote/v1/pair/cancel", body: JSONEncoder().encode(Cancellation(requestID: pending.id, secret: pending.secret)))
    }
    private func valid(_ ticket: UUID) -> Bool { generation == ticket && !Task.isCancelled }
    private func makeClient(_ url: URL, token: String? = nil, scopes: [String] = []) -> RemoteClient {
        #if DEBUG
        if let checkFixture { return checkFixture }
        #endif
        return RemoteClient(baseURL: url, token: token, certificatePin: certificatePin, scopes: scopes)
    }
    func beginCodeEntry() {
        cancelPending(); client = nil; isEnteringCode = true
        connectionCode = ""; pairingSecret = ""; codeExpiresAt = nil
    }
    func cancelCodeEntry() {
        cancelPending(); isEnteringCode = false; connectionCode = ""; pairingSecret = ""; codeExpiresAt = nil
        if let saved = try? connectionStore.load() {
            address = saved.endpoint; certificatePin = saved.certificatePin; hasPreparedConnection = true
        }
    }
    func connectUsingCode() async {
        cancelPending(); isEnteringCode = true
        do {
            let code = try ConnectionCode.decode(connectionCode, now: now())
            address = code.endpoint; certificatePin = code.pin; pairingSecret = code.secret
            codeExpiresAt = Date(timeIntervalSince1970: code.expiresAt / 1000)
            let ticket = generation
            await check()
            guard valid(ticket), phase == .needsPairing else { return }
            await pair()
        } catch { phase = .unavailable(error.localizedDescription) }
    }
    func restoreAndConnect() async {
        guard client == nil, !pairing, !isEnteringCode else { return }
        cancelPending(); let ticket = generation
        do {
            try connectionStore.importPreparedEnrollment()
            guard let saved = try connectionStore.load(), valid(ticket) else { return }
            await ConnectionVerification.shared.restoredKeychain()
            guard valid(ticket), let url = URL(string: saved.endpoint) else { return }
            hasPreparedConnection = true; address = saved.endpoint; certificatePin = saved.certificatePin
            phase = saved.pendingApproval ? .waitingForApproval : .checking
            let endpoint = makeClient(url, token: saved.token, scopes: saved.scopes)
            let info: RestoredSession = try await endpoint.request("/remote/v1/session")
            guard valid(ticket) else { return }
            guard info.deviceID == saved.deviceID else { throw RemoteFailure(message: "Device identity mismatch") }
            var refreshed = saved; refreshed.scopes = info.scopes; refreshed.pendingApproval = false
            try connectionStore.save(refreshed)
            await ConnectionVerification.shared.authenticatedSession()
            guard valid(ticket) else { return }
            client = makeClient(url, token: saved.token, scopes: info.scopes)
            if ProcessInfo.processInfo.arguments.contains("--flyx-verify-series"), let client { Task { await SeriesReadOnlyVerification.shared.run(client: client) } }
            if ProcessInfo.processInfo.arguments.contains("--flyx-verify-catalogue"), let client { Task { await CatalogReadOnlyVerification.shared.run(client: client) } }
        } catch let failure as RemoteFailure where failure.status == 401 {
            if valid(ticket) { phase = .unavailable("Mac access expired or was revoked. Get a new connection code on your Mac. Your remembered connection is kept until a new one is approved.") }
        } catch let failure as RemoteFailure where failure.status == 403 {
            if valid(ticket) { phase = .waitingForApproval }
        } catch {
            if valid(ticket) { phase = .unavailable("Couldn’t reach your remembered Mac. Retry on the same Wi-Fi, or use a new code from Mac Settings → Connect Devices. If this is a new Mac, review its connection setup there first.") }
        }
    }
    func pair() async {
        let ticket = generation
        guard let url = URL(string: address), pairingSecret.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            phase = .unavailable("Paste a complete connection code from your Mac."); return
        }
        if let codeExpiresAt, now() >= codeExpiresAt { phase = .unavailable(ConnectionCode.Failure.expired.localizedDescription); return }
        pairing = true; phase = .waitingForApproval
        defer { if generation == ticket { pairing = false; pendingPairing = nil } }
        do {
            let endpoint = makeClient(url)
            let usedSecret = pairingSecret
            let pending: PairingPending = try await endpoint.request("/remote/v1/pair/request", body: JSONEncoder().encode(PairingRequest(secret: usedSecret, name: "Flyx Remote iPhone")))
            let attempt = PendingPairing(endpoint: endpoint, id: pending.requestID, secret: usedSecret)
            guard valid(ticket) else { await cancelRequest(attempt); return }
            pendingPairing = attempt
            let end = min(now().addingTimeInterval(115), codeExpiresAt ?? .distantFuture)
            while now() < end && valid(ticket) {
                #if DEBUG
                try await Task.sleep(for: pairingPollDelay)
                #else
                try await Task.sleep(for: .seconds(1))
                #endif
                let grant: PairingGrant = try await endpoint.request("/remote/v1/pair/collect", body: JSONEncoder().encode(PairingCollect(requestID: pending.requestID)))
                guard valid(ticket) else { return }
                if grant.status == "approved", let token = grant.token, let deviceID = grant.deviceID, let scopes = grant.scopes {
                    let allowed: Set<String> = ["catalog.read", "playback.control", "watchlist.write", "downloads.read", "downloads.write"]
                    guard scopes.contains("catalog.read"), Set(scopes).isSubset(of: allowed) else { throw RemoteFailure(message: "Mac returned invalid connection permissions") }
                    let saved = RememberedConnection(endpoint: address, certificatePin: certificatePin, token: token, deviceID: deviceID, scopes: scopes, pendingApproval: false)
                    // Replacement happens only after the Mac explicitly approves the new phone grant.
                    try connectionStore.save(saved)
                    client = makeClient(url, token: token, scopes: scopes)
                    hasPreparedConnection = true; isEnteringCode = false; connectionCode = ""; pairingSecret = ""; codeExpiresAt = nil
                    return
                }
            }
            guard valid(ticket) else { return }
            throw RemoteFailure(message: "The connection code or approval expired. Create a new code on your Mac and try again.")
        } catch { if valid(ticket) { phase = .unavailable(error.localizedDescription) } }
    }
    func check() async {
        let ticket = generation
        client = nil
        guard let components = URLComponents(string: address), components.scheme == "https", let host = components.host,
              host.hasSuffix(".local"), components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.path.isEmpty || components.path == "/",
              let url = components.url else {
            phase = .unavailable("Use the connection code from Settings → Connect Devices in Flyx on your Mac."); return
        }
        phase = .checking
        do {
            let info: BridgeInfo = try await makeClient(url).request("/remote/v1/info")
            guard valid(ticket) else { return }
            guard info.protocolVersion == 1 else { throw URLError(.cannotParseResponse) }
            hostName = info.name; phase = .needsPairing
        } catch {
            if valid(ticket) { phase = .unavailable("Couldn’t reach this Mac securely. Keep Flyx open on the same Wi-Fi, then retry with its current connection code. A new Mac may need connection setup in Settings → Connect Devices.") }
        }
    }
}
struct BridgeInfo: Decodable { let protocolVersion: Int; let name: String }
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct ConnectionView: View {
    @State private var session = RemoteSession()
    @State private var work: Task<Void, Never>?
    @Environment(\.applicationMode) private var applicationMode
    @FocusState private var codeFocused: Bool
    private var connectionPreview: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--flyx-ui-fixture") && (ProcessInfo.processInfo.arguments.contains("connection-mode56") || ProcessInfo.processInfo.arguments.contains("--mode-relaunch57"))
        #else
        false
        #endif
    }
    private var busy: Bool { session.phase == .checking || session.pairing }
    var body: some View {
        Group { if let client = session.client { RemoteHomeView(client: client) } else { connectionForm } }
            .onAppear { applicationMode?.connection = session }
            .onDisappear { work?.cancel(); session.cancelPending(); if applicationMode?.connection === session { applicationMode?.connection = nil } }
            .task { if !connectionPreview { await session.restoreAndConnect() } }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                if !connectionPreview { Task { await session.restoreAndConnect() } }
            }
    }
    private var connectionForm: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("FLYX").font(.system(size: 48, weight: .black, design: .rounded)).foregroundStyle(FlyxTheme.accent)
                        Text("Your Mac. In reach.").font(.title2.bold())
                        Text("Connect with one code from Flyx on your Mac.").foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 18) {
                        Label("Get the code on your Mac", systemImage: "desktopcomputer").font(.headline)
                        instruction("1", "Open Flyx on your Mac", "Go to Settings → Connect Devices → Connect your iPhone.")
                        instruction("2", "Create and copy a connection code", "If this is a new Mac, review its connection setup there first. You do not need to rename your Mac.")
                        instruction("3", "Paste here, then approve on your Mac", "The code expires after two minutes. Keep both devices on the same home Wi-Fi.")
                    }.padding(20).background(.quaternary, in: .rect(cornerRadius: 20)).accessibilityIdentifier("connection.instructions")
                    if session.hasPreparedConnection && !session.isEnteringCode {
                        VStack(alignment: .leading, spacing: 14) {
                            Label("Remembered Mac", systemImage: "lock.shield").font(.headline)
                            Text(session.address).font(.caption.monospaced()).textSelection(.enabled).accessibilityIdentifier("connection.remembered-address")
                            status
                            Button("Retry remembered Mac") { run { await session.restoreAndConnect() } }
                                .disabled(busy).accessibilityIdentifier("connection.retry")
                            Button("Use a new connection code") { work?.cancel(); session.beginCodeEntry() }
                                .accessibilityIdentifier("connection.new-code")
                            Text("Your existing connection is kept until a new Mac approves this iPhone.").font(.footnote).foregroundStyle(.secondary)
                        }.padding(20).background(.thinMaterial, in: .rect(cornerRadius: 20))
                    } else {
                        codeEntry
                    }
                    Text("Your Mac must approve this iPhone before it can browse or control playback. You can revoke its access in Mac Settings → Connect Devices.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(24).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }.navigationTitle("Flyx Remote").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) {
                    if let applicationMode { Button("App mode") { applicationMode.settings = true }.accessibilityIdentifier("connection.app-mode") }
                } }
        }
    }
    private var codeEntry: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Enter your connection code", systemImage: "link").font(.headline)
            TextField("Paste the code from your Mac", text: $session.connectionCode, axis: .vertical)
                .lineLimit(3...5).font(.caption.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($codeFocused).privacySensitive().accessibilityIdentifier("connection.code")
                .padding(14).background(.quaternary, in: .rect(cornerRadius: 12))
            PasteButton(payloadType: String.self) { values in session.connectionCode = values.first ?? "" }
                .accessibilityLabel("Paste connection code").accessibilityIdentifier("connection.paste").disabled(busy)
            Button {
                codeFocused = false
                run { await session.connectUsingCode() }
            } label: {
                HStack { if busy { ProgressView() }; Text(session.pairing ? "Waiting for Mac approval…" : "Connect and request Mac approval").frame(maxWidth: .infinity) }
            }.buttonStyle(.borderedProminent).foregroundStyle(FlyxTheme.ink)
                .disabled(busy || session.connectionCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("connection.connect")
            status
            if busy || session.isEnteringCode {
                Button(busy ? "Cancel request" : "Cancel") { work?.cancel(); work = nil; session.cancelCodeEntry() }
                    .accessibilityIdentifier("connection.cancel")
            }
        }.padding(20).background(.thinMaterial, in: .rect(cornerRadius: 20))
    }
    private func run(_ action: @escaping @MainActor () async -> Void) {
        work?.cancel(); session.cancelPending()
        work = Task { await action() }
    }
    private func instruction(_ number: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number).font(.caption.bold()).frame(width: 26, height: 26).background(FlyxTheme.accent.opacity(0.15), in: .circle)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.bold())
                Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    @ViewBuilder private var status: some View {
        switch session.phase {
        case .disconnected: EmptyView()
        case .waitingForApproval: Label("On your Mac: Settings → Connect Devices → Approve iPhone.", systemImage: "lock.shield").font(.subheadline)
        case .checking: Text("Checking the secure Mac connection…").font(.footnote).foregroundStyle(.secondary)
        case .needsPairing: Label("Mac found. Requesting approval…", systemImage: "lock").font(.footnote)
        case .unavailable(let message): Text(message).font(.footnote).foregroundStyle(.orange).accessibilityLabel("Connection error: \(message)")
        }
    }
}
