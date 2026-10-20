import SwiftUI
import Observation
@preconcurrency import GoogleCast

struct StandaloneCastPlan:Codable,Sendable {
    let supported:Bool;let url:String?;let contentType:String?;let title:String;let reason:String?
    var relay:Bool?=nil;var sourceID:String?=nil
    var requiresRelay:Bool{relay==true}
    func receiverURL()throws->URL{
        guard supported,let raw=url,let value=URL(string:raw),value.scheme=="https",value.user==nil,value.password==nil,let host=value.host,host != "localhost",!host.hasSuffix(".local"),host.range(of:"^[0-9.]+$",options:.regularExpression)==nil,!host.contains(":") else{throw RemoteFailure(message:reason ?? "This source is not receiver-accessible. Playback stays on this iPhone.")}
        return value
    }
}
@MainActor @Observable final class StandaloneCastModel:NSObject {
    var message="Choose Cast to TV to check this source."
    var prepared=false
    var active=false
    var connecting=false
    var position:Double=0
    var duration:Double=0
    var paused=false
    var receiverName="TV"
    private(set) var captionTracks:[PlaybackCaptionTrack]=[]
    private(set) var selectedCaptionID:String?
    private(set) var volume:Double=0
    private(set) var muted=false
    @ObservationIgnored private var captionRequest:GCKRequest?
    @ObservationIgnored private var audioRequest:GCKRequest?
    static func captionTrackIDs(_ tracks:[GCKMediaTrack],active:[NSNumber],selected:String?)throws->[NSNumber]{
        let text=Set(tracks.filter{$0.type == .text}.map{$0.identifier})
        var result=active.filter{!text.contains($0.intValue)}
        if let selected{guard let id=Int(selected),text.contains(id) else{throw RemoteFailure(message:"This TV subtitle track is no longer available.")};result.append(NSNumber(value:id))}
        return result
    }
    func selectCaption(_ id:String?)throws{
        guard active,let remote,let status=remote.mediaStatus else{throw RemoteFailure(message:"The TV is not connected.")}
        let ids=try Self.captionTrackIDs(status.mediaInformation?.mediaTracks ?? [],active:status.activeTrackIDs ?? [],selected:id)
        captionRequest=remote.setActiveTrackIDs(ids);captionRequest?.delegate=self
    }
    func setVolume(_ value:Double)throws{guard active,let remote else{throw RemoteFailure(message:"The TV is not connected.")};audioRequest=remote.setStreamVolume(Float(min(1,max(0,value))));audioRequest?.delegate=self}
    func setMuted(_ value:Bool)throws{guard active,let remote else{throw RemoteFailure(message:"The TV is not connected.")};audioRequest=remote.setStreamMuted(value);audioRequest?.delegate=self}
    @ObservationIgnored private var priorIdleTimerDisabled:Bool?
    private func restoreScreenSleep(){if let prior=priorIdleTimerDisabled{UIApplication.shared.isIdleTimerDisabled=prior;priorIdleTimerDisabled=nil}}
    @ObservationIgnored private var plan:StandaloneCastPlan?
    @ObservationIgnored private var ticket=UUID()
    @ObservationIgnored private var expectedURL:String?
    @ObservationIgnored private var context:GCKCastContext?
    @ObservationIgnored private var remote:GCKRemoteMediaClient?
    @ObservationIgnored private var timeout:Task<Void,Never>?
    @ObservationIgnored private var loadRequest:GCKRequest?
    @ObservationIgnored private var ownedSession:GCKCastSession?
    @ObservationIgnored private var relayFactory:((String)throws->SelectedMediaRelay)?
    @ObservationIgnored private var relayServer:SelectedMediaRelay?
    @ObservationIgnored private var loadTask:Task<Void,Never>?
    var requiresForeground:Bool{plan?.requiresRelay==true || relayServer != nil}
    @ObservationIgnored private var capture:(()->(Double,Bool))?
    @ObservationIgnored private var confirmed:(()->Void)?
    var sdkReady:Bool{context != nil}
    func prepare(_ plan:StandaloneCastPlan,relayFactory:((String)throws->SelectedMediaRelay)?=nil,capture:@escaping()->(Double,Bool),confirmed:@escaping()->Void){
        cancelPending();self.plan=plan;self.capture=capture;self.confirmed=confirmed;self.relayFactory=relayFactory
        do{if plan.requiresRelay{guard relayFactory != nil else{throw RemoteFailure(message:"This source needs a foreground TV connection.")}}else{_ = try plan.receiverURL()};prepared=true;message=plan.requiresRelay ? "Choose a nearby Google Cast TV. Keep Flyx open and your iPhone unlocked while casting.":"Choose a nearby Google Cast TV. Your iPhone keeps playing until the TV is ready."}catch{prepared=false;message=error.localizedDescription}
    }
    func enablePicker(){
        guard prepared else{return}
        if !GCKCastContext.isSharedInstanceInitialized(){let options=GCKCastOptions(discoveryCriteria:GCKDiscoveryCriteria(applicationID:kGCKDefaultMediaReceiverApplicationID));options.disableDiscoveryAutostart=true;options.startDiscoveryAfterFirstTapOnCastButton=true;options.disableAnalyticsLogging=true;GCKCastContext.setSharedInstanceWith(options)}
        GCKLogger.sharedInstance().consoleLoggingEnabled=false
        context=GCKCastContext.sharedInstance();context?.sessionManager.add(self);message="Tap the Cast button, then choose your nearby TV. No media loads until a TV is selected."
    }
    private func loadSelected(_ session:GCKCastSession){
        guard prepared,let plan,let remote=session.remoteMediaClient else{return}
        ownedSession=session;connecting=true;receiverName=session.device.friendlyName ?? "TV";message="Connecting to \(receiverName)…";self.remote=remote;remote.add(self)
        let current=ticket
        loadTask=Task{
            do{
                let url:URL
                if plan.requiresRelay{
                    guard let address=session.device.networkAddress.ipAddress,let factory=relayFactory else{throw RemoteFailure(message:"The TV Wi-Fi address is unavailable. Playback stays on iPhone.")}
                    let server=try factory(address);relayServer=server;url=try await server.start()
                }else{url=try plan.receiverURL()}
                try Task.checkCancellation();guard ticket==current,connecting else{return}
                let state=capture?() ?? (0,false);position=max(0,state.0);paused=state.1;expectedURL=url.absoluteString
                let info=GCKMediaInformationBuilder(contentURL:url);info.contentType=plan.contentType;info.streamType = .buffered
                let metadata=GCKMediaMetadata(metadataType:.generic);metadata.setString(plan.title,forKey:kGCKMetadataKeyTitle);info.metadata=metadata
                let load=GCKMediaLoadRequestDataBuilder();load.mediaInformation=info.build();load.startTime=position;load.autoplay=NSNumber(value:!paused)
                let request=remote.loadMedia(with:load.build());loadRequest=request;request.delegate=self
                timeout=Task{try? await Task.sleep(for:.seconds(20));guard !Task.isCancelled,self.ticket==current,self.connecting else{return};self.message="The TV did not confirm this media. Playback stays on iPhone.";self.end()}
            }catch{guard ticket==current else{return};message=(error as? RemoteFailure)?.message ?? "The TV media connection could not start. Playback stays on iPhone.";end()}
        }
    }
    func relayFailed(_ message:String){guard relayServer != nil else{return};self.message=message;end()}
    func applicationBackgrounded(){guard relayServer != nil else{return};message="Casting stopped because Flyx went into the background. Return to iPhone to continue.";end()}
    func acceptStatus(contentID:String,position:Double,duration:Double,paused:Bool,ticket:UUID?=nil){
        if let ticket,ticket != self.ticket{return}
        guard connecting || active,contentID==expectedURL,position.isFinite,duration.isFinite,duration>0 else{return}
        self.position=max(0,position);self.duration=duration;self.paused=paused
        if !active{if relayServer != nil{priorIdleTimerDisabled=UIApplication.shared.isIdleTimerDisabled;UIApplication.shared.isIdleTimerDisabled=true};active=true;connecting=false;timeout?.cancel();confirmed?()}
        message="\(paused ? "Paused":"Playing") on \(receiverName)"
    }
    func action(_ action:String,seconds:Double?=nil){
        guard active,let remote else{return}
        switch action{case "pause":remote.pause();case "resume":remote.play();case "seek":let options=GCKMediaSeekOptions();options.interval=max(0,seconds ?? 0);remote.seek(with:options);case "stop":end();default:break}
    }
    func cancelPending(){restoreScreenSleep();ticket=UUID();loadTask?.cancel();loadTask=nil;relayServer?.stop();relayServer=nil;relayFactory=nil;timeout?.cancel();timeout=nil;connecting=false;prepared=false;plan=nil;capture=nil;confirmed=nil}
    func end(stopReceiver:Bool=true){
        let owned=active || connecting
        let currentURL=remote?.mediaStatus?.mediaInformation?.contentURL?.absoluteString ?? remote?.mediaStatus?.mediaInformation?.contentID
        let stopSelected=stopReceiver && expectedURL != nil && currentURL==expectedURL
        cancelPending();active=false;captionTracks=[];selectedCaptionID=nil;captionRequest=nil;audioRequest=nil;expectedURL=nil;remote?.remove(self);remote=nil;loadRequest=nil;ownedSession=nil
        if owned{_ = context?.sessionManager.endSessionAndStopCasting(stopSelected)}
        context?.sessionManager.remove(self);context?.discoveryManager.stopDiscovery()
    }
    #if DEBUG
    func inertRelay62(_ relay:SelectedMediaRelay,url:URL)->UUID{relayServer=relay;return inertArm(url)}
    func inertArm(_ url:URL)->UUID{ticket=UUID();expectedURL=url.absoluteString;connecting=true;return ticket}
    #endif
}
extension StandaloneCastModel:@preconcurrency GCKSessionManagerListener,@preconcurrency GCKRemoteMediaClientListener,@preconcurrency GCKRequestDelegate{
    func sessionManager(_ manager:GCKSessionManager,willStart session:GCKSession){guard prepared else{return};ownedSession=session as? GCKCastSession;connecting=true;message="Connecting to the selected TV…"}
    func sessionManager(_ manager:GCKSessionManager,didStart session:GCKSession){if let cast=session as? GCKCastSession{loadSelected(cast)}}
    func sessionManager(_ manager:GCKSessionManager,didResume session:GCKSession){message="A previous Cast session is available. Select a TV explicitly before loading this title."}
    func sessionManager(_ manager:GCKSessionManager,didFailToStart session:GCKSession,withError error:Error){connecting=false;message="Could not connect to the TV. Check that iPhone and TV share Wi-Fi. Playback stays on iPhone."}
    func sessionManager(_ manager:GCKSessionManager,didEnd session:GCKSession,withError error:Error?){guard session === ownedSession else{return};restoreScreenSleep();relayServer?.stop();relayServer=nil;loadTask?.cancel();loadTask=nil;active=false;connecting=false;remote=nil;message=error==nil ? "Disconnected from TV.":"TV connection lost. Return to iPhone to resume."}
    func remoteMediaClient(_ client:GCKRemoteMediaClient,didUpdate mediaStatus:GCKMediaStatus?){
        guard client === remote,let mediaStatus,let info=mediaStatus.mediaInformation else{return}
        let currentURL=info.contentURL?.absoluteString ?? info.contentID ?? ""
        if active,currentURL != expectedURL{message="The TV changed to another video. Return to iPhone to continue.";end(stopReceiver:false);return}
        guard currentURL==expectedURL else{return}
        let tracks=info.mediaTracks ?? []
        captionTracks=tracks.filter{$0.type == .text}.map{.init(id:String($0.identifier),label:$0.name ?? $0.languageCode ?? "Subtitles")}
        let ids=Set((mediaStatus.activeTrackIDs ?? []).map{$0.stringValue})
        selectedCaptionID=captionTracks.first{ids.contains($0.id)}?.id
        volume=Double(mediaStatus.volume);muted=mediaStatus.isMuted
        if mediaStatus.playerState == .idle{message=mediaStatus.idleReason == .finished ? "Playback finished on TV.":"The TV could not continue this source. Return to iPhone to continue.";if mediaStatus.idleReason == .finished{position=info.streamDuration};end();return}
        guard [GCKMediaPlayerState.playing,.paused].contains(mediaStatus.playerState) else{return}
        acceptStatus(contentID:currentURL,position:client.approximateStreamPosition(),duration:info.streamDuration,paused:mediaStatus.playerState == .paused)
    }
    func request(_ request:GCKRequest,didFailWithError error:GCKError){if request === captionRequest{message="The TV could not change subtitles. The reported selection is unchanged.";return};if request === audioRequest{message="The TV could not change audio. Try again.";return};guard request === loadRequest else{return};message="The TV rejected the selected media. Return to iPhone to continue.";end()}
}
struct NativeCastButton:UIViewRepresentable{
    func makeUIView(context:Context)->GCKUICastButton{let button=GCKUICastButton(frame:CGRect(x:0,y:0,width:48,height:48));button.tintColor = .systemGreen;return button}
    func updateUIView(_ view:GCKUICastButton,context:Context){}
}
struct StandaloneCastSheet:View{
    let client:RemoteClient;let phone:PhonePlaybackModel;let model:StandaloneCastModel
    let confirmed:()->Void
    @Environment(\.dismiss) private var dismiss
    var body:some View{NavigationStack{VStack(alignment:.leading,spacing:24){Text(model.message).accessibilityIdentifier("cast.status");if model.prepared{if model.sdkReady{NativeCastButton().frame(width:60,height:60)}else{Button("Choose a nearby Google Cast TV"){model.enablePicker()}.buttonStyle(.borderedProminent)}};if model.requiresForeground{Text("Flyx keeps the screen awake while casting. Manually locking the phone or leaving Flyx stops this connection.").font(.footnote).foregroundStyle(.secondary)};Text("Only the selected video is sent. The TV chooses streaming quality. Your iPhone quality preference is kept for when you return.").font(.footnote).foregroundStyle(.secondary);Spacer()}.padding(24).navigationTitle("Cast to TV").toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){dismiss()}}}.task{do{let snapshot=try phone.transferSnapshot();let plan:StandaloneCastPlan=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"cast-info",handle:snapshot.handle)));try Task.checkCancellation();model.prepare(plan,relayFactory:plan.requiresRelay ? { receiver in
                    let binding=try PrivateLANBinding.select(receiver:receiver)
                    return try SelectedMediaRelay(client:client,handle:snapshot.handle,sourceID:plan.sourceID ?? "",binding:binding,failure:{message in Task{@MainActor in model.relayFailed(message)}})
                }:nil,capture:{let time=phone.player.currentTime().seconds;return(time.isFinite ? time:0,phone.player.rate==0)},confirmed:{phone.recordProgress(client,force:true);phone.suppressLocalProgress=true;phone.player.pause();confirmed();dismiss()})}catch{model.message=error.localizedDescription}}.onDisappear{if !model.active{model.end()}}}}
}

#if DEBUG
@MainActor struct StandaloneCastChecksView:View{
    @State private var model=StandaloneCastModel()
    @State private var finished=false
    var body:some View{NavigationStack{VStack(alignment:.leading,spacing:24){Text(model.message).accessibilityIdentifier("cast.status");Text(finished ? "Inert receiver checks complete. No TV discovery or session was started.":"Checking direct media policy and receiver state…").font(.footnote).foregroundStyle(.secondary);Spacer()}.padding(24).navigationTitle("Cast to TV")}.task{await verify()}}
    private func verify()async{
        let modeKey="flyx.preferredApplicationMode",priorMode=UserDefaults.standard.string(forKey:"flyx.preferredApplicationMode")
        defer{if let priorMode{UserDefaults.standard.set(priorMode,forKey:modeKey)}else{UserDefaults.standard.removeObject(forKey:modeKey)}}
        var proof:[String:Any]=["sdkInitializedBefore":GCKCastContext.isSharedInstanceInitialized(),"hardwareDiscoveryPerformed":false,"tvSessionStarted":false]
        let service=StandaloneService(),policy=await service.debugCastPolicy61();proof["policy"]=(try? JSONSerialization.jsonObject(with:policy)) ?? [:]
        let url=URL(string:"https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8")!
        let plan=StandaloneCastPlan(supported:true,url:url.absoluteString,contentType:"application/vnd.apple.mpegurl",title:"Explicit public HLS test sample",reason:nil)
        model.prepare(plan,capture:{(35,true)},confirmed:{})
        let info=GCKMediaInformationBuilder(contentURL:url);info.contentType=plan.contentType;info.streamType = .buffered
        let builder=GCKMediaLoadRequestDataBuilder();builder.mediaInformation=info.build();builder.startTime=35;builder.autoplay=NSNumber(value:false)
        let load=builder.build();proof["sdkLoadPreservesTime"]=load.startTime==35;proof["sdkLoadPreservesPause"]=load.autoplay?.boolValue==false;proof["sdkUsesRemoteHTTPS"]=load.mediaInformation?.contentURL?.scheme=="https"
        let first=model.inertArm(url);model.acceptStatus(contentID:"wrong-title",position:35,duration:300,paused:true,ticket:first);proof["wrongMediaIgnored"] = !model.active
        model.acceptStatus(contentID:url.absoluteString,position:35,duration:300,paused:true,ticket:first);proof["matchingReceiverAckAccepted"]=model.active && model.position==35 && model.paused
        model.end();model.acceptStatus(contentID:url.absoluteString,position:99,duration:300,paused:false,ticket:first);proof["lateAckAfterEndIgnored"] = !model.active
        let second=model.inertArm(url);model.cancelPending();model.acceptStatus(contentID:url.absoluteString,position:99,duration:300,paused:false,ticket:second);proof["cancelledAckIgnored"] = !model.active
        let mode=ApplicationModeModel();mode.mode = .standalone;let oldOwner=mode.playback;_ = oldOwner.directCast.inertArm(url);mode.choose(.remote);proof["pendingCastRequiresModeConfirmation"]=mode.mode == .standalone && mode.requestedMode == .remote;mode.choose(.remote,endingPlayback:true);proof["confirmedModeSwitchCancelsCast"]=mode.mode == .remote && !oldOwner.directCast.connecting && !oldOwner.directCast.active
        proof["sdkInitializedAfter"]=GCKCastContext.isSharedInstanceInitialized()
        model.prepare(.init(supported:false,url:nil,contentType:nil,title:"Provider source",reason:"This source needs phone-only headers, cookies or segment conversion. Direct TV playback is unavailable. A foreground LAN relay is not implemented yet."),capture:{(0,false)},confirmed:{})
        proof["unsupportedSourceDoesNotEnableSDK"] = !model.prepared && !model.sdkReady
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        if let data=try? JSONSerialization.data(withJSONObject:proof,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("standalone-cast61.json"),options:.atomic)};finished=true
    }
}
extension StandaloneService{
    func debugCastPolicy61()async->Data{
        let source=StandaloneSource(url:URL(string:"https://provider.invalid/video.m3u8")!,headers:["Referer":"https://provider.invalid/"],format:"hls",provider:"Inert private-header source",quality:"Auto",language:"")
        let handle="cast-policy-inert";media[handle] = .init(selection:["contentID":1,"season":1,"episode":3],kind:"anime",title:"Inert episode3",sources:[source],resources:["0":source.url])
        var result:[String:Any]=[:]
        if let response=try? await request("/remote/v1/media",query:[],body:JSONEncoder().encode(PhoneMediaOperation(operation:"cast-info",handle:handle))),let plan=try? JSONDecoder().decode(StandaloneCastPlan.self,from:response){result["phoneOnlyProviderBlocked"] = !plan.supported && plan.url==nil;result["noProviderHeadersExported"] = !String(decoding:response,as:UTF8.self).contains("Referer")}
        for raw in ["http://127.0.0.1:1234/resource/0","https://localhost/video","https://private.local/video","https://192.168.0.1/video"]{do{_ = try StandaloneCastPlan(supported:true,url:raw,contentType:"video/mp4",title:"Inert",reason:nil).receiverURL();result["localURLRejected"] = false;break}catch{result["localURLRejected"] = true}}
        result["networkRequests"]=debugNetworkRequests;media.removeValue(forKey:handle)
        return (try? JSONSerialization.data(withJSONObject:result)) ?? Data()
    }
}
#endif
