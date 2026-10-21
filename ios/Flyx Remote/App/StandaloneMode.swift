import SwiftUI
import Observation
import Security

/// Personal TMDB access stays in the existing non-synchronizing device-only Keychain item.
enum StandaloneCredentials {
    static var query:[String:Any]{[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"local.flyx.standalone.tmdb",kSecAttrAccount as String:"personal-token",kSecAttrSynchronizable as String:false]}
    static var hasToken:Bool{load() != nil}
    static func load()->TMDBCredential?{
        var result:CFTypeRef?
        guard SecItemCopyMatching(query.merging([kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]){_,n in n} as CFDictionary,&result)==errSecSuccess,let data=result as? Data else{return nil}
        if let credential=try? JSONDecoder().decode(TMDBCredential.self,from:data){return credential}
        return String(data:data,encoding:.utf8).flatMap(TMDBCredential.legacy)
    }
    static func save(_ credential:TMDBCredential)throws{
        let attrs:[String:Any]=[kSecValueData as String:try JSONEncoder().encode(credential),kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status=SecItemUpdate(query as CFDictionary,attrs as CFDictionary)
        if status==errSecItemNotFound{status=SecItemAdd(query.merging(attrs){_,n in n} as CFDictionary,nil)}
        guard status==errSecSuccess else{throw RemoteFailure(message:"Could not save your TMDB access securely.")}
    }
}
@MainActor @Observable final class ApplicationModeModel {
    enum Mode:String,CaseIterable,Identifiable {case standalone,remote;var id:String{rawValue};var label:String{self == .standalone ? "Standalone":"Mac Remote"}}
    var routingPreference=UserDefaults.standard.string(forKey:"flyx.routingPreference.v1") ?? "automatic"
    var mode:Mode? = .standalone
    let standaloneClient=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,scopes:["catalog.read","playback.control","watchlist.write"],standalone:StandaloneService.shared)
    var automaticClient:RemoteClient?
    var offlineMacClient:RemoteClient?
    var reconnectAfter=Date.distantPast
    @ObservationIgnored private var probeTask:Task<RestoredSession,Error>?
    @ObservationIgnored private var probeID:UUID?
    #if DEBUG
    var probeTimeout:Duration = .seconds(4)
    #endif
    var lastInteraction=Date.distantPast
    var homeAtRoot=true
    var displayGeneration=0
    #if DEBUG
    var automaticFixture:RememberedConnection?
    var automaticFixtureClient:RemoteClient?
    #endif
    init(){if routingPreference=="remote"{mode = .remote}}
    var catalogueRevision=0
    var generation=0
    var settings=false
    var requestedMode:Mode?
    var warning:String?
    var activeClient:RemoteClient?
    var playback=PlaybackSession()
    @ObservationIgnored weak var connection:RemoteSession?
    var maySwitch:Bool{!playback.phone.ready && !playback.phone.busy && !playback.busy && !playback.transfer.pending && !playback.directCast.active && !playback.directCast.connecting}
    func useAutomatic(){
        routingPreference="automatic";UserDefaults.standard.set("automatic",forKey:"flyx.routingPreference.v1")
        // Automatic reconnects at the next safe Home boundary, preserving navigation and playback.
    }
    func recordInteraction(){lastInteraction=Date()}
    var safeAutomaticBoundary:Bool{maySwitch && !playback.retainsPlaybackContext && !settings && homeAtRoot && playback.selectedTab=="home" && Date().timeIntervalSince(lastInteraction)>3}
    /// A health check has a wall-clock deadline, including DNS/connectivity stalls.
    nonisolated private static func session(_ client:RemoteClient,timeout:Duration)async throws->RestoredSession{
        try await withThrowingTaskGroup(of:RestoredSession.self){group in
            group.addTask{try await client.request("/remote/v1/session")}
            group.addTask{try await Task.sleep(for:timeout);throw URLError(.timedOut)}
            defer{group.cancelAll()}
            return try await group.next()!
        }
    }
    func connectAutomatically()async{
        guard routingPreference=="automatic",mode != nil,probeID==nil else{return}
        let wasRemote=mode == .remote
        // Losing the Mac must work from any screen. Adopting it still waits for idle Home.
        guard wasRemote || (safeAutomaticBoundary && Date()>=reconnectAfter) else{return}
        let ticket=generation,id=UUID();probeID=id
        defer{if probeID==id{probeID=nil;probeTask=nil}}
        do{
            let saved:RememberedConnection
            let client:RemoteClient
            #if DEBUG
            if let fixture=automaticFixture,let fixtureClient=automaticFixtureClient{saved=fixture;client=fixtureClient}
            else{guard let value=try RememberedConnectionStore().load(),!value.pendingApproval,let url=URL(string:value.endpoint) else{return};saved=value;client=RemoteClient(baseURL:url,token:value.token,certificatePin:value.certificatePin,scopes:value.scopes)}
            let timeout=probeTimeout
            #else
            guard let value=try RememberedConnectionStore().load(),!value.pendingApproval,let url=URL(string:value.endpoint) else{return};saved=value;client=RemoteClient(baseURL:url,token:value.token,certificatePin:value.certificatePin,scopes:value.scopes)
            let timeout:Duration = .seconds(4)
            #endif
            let work=Task{try await Self.session(client,timeout:timeout)};probeTask=work
            let session=try await withTaskCancellationHandler{try await work.value}onCancel:{work.cancel()}
            try Task.checkCancellation()
            guard session.deviceID==saved.deviceID else{throw RemoteFailure(message:"The saved Mac identity did not match.")}
            guard routingPreference=="automatic",generation==ticket,probeID==id else{return}
            if wasRemote,mode == .remote{return}
            guard safeAutomaticBoundary else{return}
            automaticClient=RemoteClient(baseURL:client.baseURL,token:saved.token,certificatePin:saved.certificatePin,scopes:session.scopes)
            mode = .remote;activeClient=automaticClient;generation+=1
        }catch{
            guard !Task.isCancelled,routingPreference=="automatic",generation==ticket,probeID==id,wasRemote else{return}
            let oldClient=automaticClient ?? activeClient;offlineMacClient=oldClient
            connection?.cancelPending();connection=nil
            if let oldClient,!oldClient.isStandalone{playback.macBecameUnavailable(oldClient)}
            automaticClient=nil;activeClient=standaloneClient;mode = .standalone;generation+=1
            reconnectAfter=Date().addingTimeInterval(10)
        }
    }
    func choose(_ value:Mode,endingPlayback:Bool=false){
        guard mode != value else{routingPreference=value.rawValue;UserDefaults.standard.set(value.rawValue,forKey:"flyx.routingPreference.v1");requestedMode=nil;return}
        guard maySwitch || endingPlayback else{requestedMode=value;warning="Switching ends the current playback connection and cancels pending work.";return}
        probeTask?.cancel();probeTask=nil;probeID=nil
        connection?.cancelPending();connection=nil
        let old=playback;old.directCast.end()
        if let client=old.controlClient ?? activeClient{old.cancel(client);old.phone.stop(client)}else{old.workTask?.cancel();old.phone.player.pause();old.phone.player.replaceCurrentItem(with:nil)}
        old.epoch+=1;generation+=1;displayGeneration+=1;homeAtRoot=true;playback=PlaybackSession();activeClient=nil
        automaticClient=nil;offlineMacClient=nil;routingPreference=value.rawValue
        UserDefaults.standard.set(value.rawValue,forKey:"flyx.routingPreference.v1")
        mode=value;UserDefaults.standard.set(value.rawValue,forKey:"flyx.preferredApplicationMode")
        warning=nil;requestedMode=nil;settings=false
    }
}
private struct ApplicationModeKey:EnvironmentKey{static let defaultValue:ApplicationModeModel?=nil}
extension EnvironmentValues{var applicationMode:ApplicationModeModel?{get{self[ApplicationModeKey.self]}set{self[ApplicationModeKey.self]=newValue}}}

struct ApplicationModeRoot:View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model=ApplicationModeModel()
    private var standalone:RemoteClient{model.standaloneClient}
    var body:some View {
        Group {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--relay-check62"){RelayChecks62()}
            else if ProcessInfo.processInfo.arguments.contains("--cast-check61"){StandaloneCastChecksView()}
            else if ProcessInfo.processInfo.arguments.contains("--quality-check60"){StandaloneQualityCheckpoint60(client:standalone)}
            else if ProcessInfo.processInfo.arguments.contains("--standalone-spot59"){StandaloneSpotCheckpoint59(client:standalone)}
            else if ProcessInfo.processInfo.arguments.contains("--standalone-catalogue58"){StandaloneCataloguePlaybackCheckpoint(client:standalone)}
            else if ProcessInfo.processInfo.arguments.contains("--mode-seed57") || ProcessInfo.processInfo.arguments.contains("--mode-seed-standalone57") || ProcessInfo.processInfo.arguments.contains("--mode-relaunch57"){Color.black}
            else if ProcessInfo.processInfo.arguments.contains("--standalone-mode-check56"){StandaloneModeChecksView()}
            else if ProcessInfo.processInfo.arguments.contains("--standalone-coverage54"){StandaloneCoverageCheckpoint(client:standalone)}
            else if ProcessInfo.processInfo.arguments.contains("--weeb-reader67") {StandaloneMangaCheckpoint(client:standalone)}
            else if ProcessInfo.processInfo.arguments.contains("--standalone-reader54") || ProcessInfo.processInfo.arguments.contains("--standalone-detail54") {StandaloneMangaCheckpoint(client:standalone)}
            else if ProcessInfo.processInfo.arguments.contains("--standalone-player53") || ProcessInfo.processInfo.arguments.contains("--standalone-movie54") || ProcessInfo.processInfo.arguments.contains("--standalone-tv56") || ProcessInfo.processInfo.arguments.contains("--standalone-anime57") {StandalonePlaybackCheckpoint(client:standalone)}
            else {modeContent}
            #else
            modeContent
            #endif
        }.environment(\.applicationMode,model).environment(\.playbackSession,model.playback)
            .simultaneousGesture(TapGesture().onEnded{model.recordInteraction()})
            .simultaneousGesture(DragGesture(minimumDistance:12).onChanged{_ in model.recordInteraction()})
            .task(id:"\(scenePhase):\(model.routingPreference)"){
                guard scenePhase == .active else{return}
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("--")}){return}
                #endif
                while !Task.isCancelled{
                    await model.connectAutomatically()
                    do{try await Task.sleep(for:.seconds(model.mode == .remote ? 3:10))}catch{return}
                }
            }
            .onChange(of:scenePhase){_,phase in if phase == .background{model.playback.directCast.applicationBackgrounded()}}
            .sheet(isPresented:$model.settings){ApplicationModeSettings(model:model)}
            .task{
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--mode-seed57"){model.choose(.remote,endingPlayback:true);model.settings=true}
                if ProcessInfo.processInfo.arguments.contains("--mode-seed-standalone57"){model.choose(.standalone,endingPlayback:true);model.settings=true}
                if ProcessInfo.processInfo.arguments.contains("--mode-relaunch57"){UIOnlyProtocol.probe(["relaunchMode57":model.mode?.rawValue ?? "unset"]);model.settings=true}
                if ProcessInfo.processInfo.arguments.contains("--standalone-chooser53"){model.mode=nil;return}
                if ProcessInfo.processInfo.arguments.contains("--standalone-browse54"){model.playback.selectedTab="browse"}
                if ProcessInfo.processInfo.arguments.contains("--standalone-settings54"){model.settings=true}
                if ProcessInfo.processInfo.arguments.contains("--standalone-qa"){model.playback.phone.player.isMuted=true;model.playback.phone.player.volume=0;model.mode = .standalone}
                #endif
                if model.mode == nil{model.mode = .standalone}
            }
    }
    @ViewBuilder private var modeContent:some View {
        if model.mode == .standalone || model.automaticClient != nil {
            RemoteHomeView(client:model.automaticClient ?? standalone).id("home-\(model.catalogueRevision)-\(model.displayGeneration)")
        }
        else if model.mode == .remote {ConnectionView().id("remote-\(model.generation)")}
        else {chooser}
    }
    private var chooser:some View {NavigationStack{VStack(alignment:.leading,spacing:24){Text("FLYX").font(.system(size:48,weight:.black,design:.rounded)).foregroundStyle(FlyxTheme.accent);Text("Your library. Your choice.").font(.title.bold());Text("Use Flyx on this iPhone or connect to your Mac.").foregroundStyle(.secondary);Button{model.choose(.standalone)}label:{Label("Standalone · This iPhone",systemImage:"iphone").frame(maxWidth:.infinity,minHeight:52)}.buttonStyle(.borderedProminent).foregroundStyle(FlyxTheme.ink).accessibilityIdentifier("mode.standalone");Button{model.choose(.remote)}label:{Label("Mac Remote",systemImage:"desktopcomputer").frame(maxWidth:.infinity,minHeight:52)}.buttonStyle(.bordered).accessibilityIdentifier("mode.remote");Text("Watchlist changes sync with your paired Mac when it is available. Progress stays on this iPhone.").font(.footnote).foregroundStyle(.secondary);Spacer()}.padding(24).navigationTitle("Flyx")}}
}
struct ApplicationModeSettings:View{
    let model:ApplicationModeModel
    @Environment(\.dismiss) private var dismiss
    var body:some View{NavigationStack{Form{
        Section("App mode"){
            Picker("Connection",selection:Binding(get:{model.routingPreference},set:{if $0=="automatic"{model.useAutomatic()}else if let next=ApplicationModeModel.Mode(rawValue:$0){model.choose(next)}})){
                Text("Automatic").tag("automatic")
                Text("This iPhone").tag("standalone")
                Text("Mac Remote").tag("remote")
            }.accessibilityIdentifier("settings.connection-mode")
            Text(model.routingPreference=="automatic" ? "Opens Home immediately. Prefers your paired Mac and reconnects when it returns. Uses this iPhone if the Mac stops responding. Reconnects at idle Home; navigation and current playback stay in place.":model.mode == .remote ? "Connect to your Mac using its saved pairing.":"Browse and play independently on this iPhone.").font(.footnote).foregroundStyle(.secondary)
        }
        if model.mode == .standalone{StandaloneTokenSettings().environment(\.applicationMode,model)}
        if let warning=model.warning{Text(warning).font(.footnote).foregroundStyle(.secondary)}
    }.navigationTitle("Settings").toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){model.settings=false;dismiss()}}}}
    .confirmationDialog("Switch app mode?",isPresented:Binding(get:{model.requestedMode != nil},set:{if !$0{model.requestedMode=nil}}),titleVisibility:.visible){
        Button("End current playback, cancel work and switch",role:.destructive){if let next=model.requestedMode{model.choose(next,endingPlayback:true);dismiss()}}
        Button("Cancel",role:.cancel){model.requestedMode=nil}
    }message:{Text("This ends iPhone playback and cancels pending work. Switching does not start playback on your Mac or TV.")}
    }
}
struct AppSettingsButton:View {
    @Environment(\.applicationMode) private var model
    var body:some View {if let model{Button{model.settings=true}label:{Image(systemName:"gearshape").font(.title3).frame(width:44,height:44)}.buttonStyle(.plain).accessibilityLabel("Settings").accessibilityIdentifier("app.settings")}}
}
private struct StandaloneTokenSettings:View {
    @Environment(\.applicationMode) private var model
    @State private var kind:TMDBCredential.Kind = .apiKey
    @State private var value=""
    @State private var message:String?
    @State private var validating=false
    var body:some View{Section("Personal TMDB access"){
        Text("Choose the matching value from TMDB API settings. Both options support Movies and TV. Anime browsing works without one.").font(.footnote)
        Picker("Credential type",selection:$kind){ForEach(TMDBCredential.Kind.allCases){kind in Text(kind.label).tag(kind)}}.disabled(validating)
        SecureField(kind.label,text:$value).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(validating)
        Button{Task{await validateAndSave()}}label:{HStack{if validating{ProgressView()};Text(validating ? "Checking TMDB…":"Validate and save on this iPhone")}}.disabled(value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || validating)
        Link("Open TMDB API settings",destination:URL(string:"https://www.themoviedb.org/settings/api")!)
        if let message{Text(message).font(.footnote)}
    }}
    @MainActor private func validateAndSave()async{
        validating=true;message=nil;defer{validating=false}
        do{
            let credential=try TMDBCredential(kind:kind,value:value)
            let session=TMDBAccess.validationSession();defer{session.invalidateAndCancel()}
            try await TMDBAccess.validate(credential,session:session);try Task.checkCancellation()
            try StandaloneCredentials.save(credential);await StandaloneService.shared.invalidateCatalogueCaches();value="";model?.catalogueRevision+=1
            message="TMDB accepted your credential. Saved securely on this iPhone."
        }catch is CancellationError{}catch{message=error.localizedDescription}
    }
}
