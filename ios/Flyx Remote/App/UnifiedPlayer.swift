import SwiftUI
@preconcurrency import AVKit

struct PlayerPresentation:Identifiable {let id=UUID();let selection:PhonePlaybackSelection;let phone:Bool;var position:Double?=nil}

/// One portrait control surface for local and remote playback. AVPlayer stays
/// owned by this screen when its video expands; rotation does not re-prepare it.
@MainActor struct RemoteControlView:View {
    let client:RemoteClient
    var initialSelection:PhonePlaybackSelection?=nil
    var initialItem:RemoteTitle?=nil
    var startsOnPhone=false
    var initialPosition:Double?=nil
    var showClose=false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.playbackSession) private var sharedSession
    @State private var localSession=PlaybackSession()
    @State private var presentationID=UUID()
    private var session:PlaybackSession{sharedSession ?? localSession}
    private var phone:PhonePlaybackModel{session.phone}
    private var phoneActive:Bool{get{session.phoneActive}nonmutating set{session.phoneActive=newValue}}
    private var status:PlaybackStatus?{get{session.status}nonmutating set{session.status=newValue}}
    private var busy:Bool{get{session.busy}nonmutating set{session.busy=newValue}}
    private var error:String?{get{session.error}nonmutating set{session.error=newValue}}
    @State private var seek=0.0
    @State private var scrubbing=false
    @State private var audioVolume=0.0
    @State private var audioScrubbing=false
    @State private var outputsPresented=false
    @State private var fullScreen=false
    @State private var suppressLandscapeFullscreen=false
    @State private var devices:[RemoteCastDevice]=[]
    private var transferV2:Bool{get{session.transferV2}nonmutating set{session.transferV2=newValue}}
    private var macSourcesSupported:Bool{get{session.macSourcesSupported}nonmutating set{session.macSourcesSupported=newValue}}
    private var macSources:[MacSourceChoice]{get{session.macSources}nonmutating set{session.macSources=newValue}}
    private var transfer:DestinationTransferModel{session.transfer}
    @State private var receiverPicker=false
    private var workTask:Task<Void,Never>?{get{session.workTask}nonmutating set{session.workTask=newValue}}
    private var active:Bool{phoneActive ? phone.ready:status?.state != nil && status?.state != "idle"}
    private var playing:Bool{phoneActive ? phone.player.rate>0:status?.state=="playing"}
    private var duration:Double{let value=phoneActive ? phone.player.currentItem?.duration.seconds:status?.duration;return value?.isFinite==true ? max(0,value!):0}
    private var output:String{phoneActive ? "This iPhone":status?.outputName ?? "Mac"}
    private var outputSymbol:String{phoneActive ? "iphone":status?.output=="tv" ? "tv":"desktopcomputer"}
    private var sourceInfo:PlaybackSourceInfo?{phoneActive ? phone.sourceInfo:status?.sourceInfo}
    private var resolutionLabel:String {
        let size=phoneActive ? phone.player.currentItem?.presentationSize:nil
        let width=phoneActive ? size.map{Double($0.width)}:status?.videoWidth.map{Double($0)}
        let height=phoneActive ? size.map{Double($0.height)}:status?.videoHeight.map{Double($0)}
        guard let width,let height,width.isFinite,height.isFinite,width>0,height>0,width<=16384,height<=16384 else{return "Resolution unknown"}
        return "\(Int(width)) × \(Int(height)) decoded"
    }
    private var nowPlaying:RemoteTitle{phoneActive ? RemoteTitle(id:"current-phone",kind:"movie",title:phone.title,overview:"",posterURL:session.phoneArtwork):RemoteTitle(id:"current-remote",kind:"movie",title:status?.title ?? initialItem?.title ?? "Nothing playing",overview:"",posterURL:status?.artworkURL ?? initialItem?.posterURL)}
    var body:some View {GeometryReader{geometry in
        let landscape=UIDevice.current.userInterfaceIdiom == .phone && geometry.size.width>geometry.size.height
        let immersive=phoneActive && (fullScreen || (landscape && !suppressLandscapeFullscreen))
        NavigationStack {
            Group {
                if immersive {immersivePlayer}
                else {portrait}
            }.background(.black).navigationTitle("Now Playing").navigationBarTitleDisplayMode(.inline)
                .toolbar(immersive ? .hidden:.visible,for:.navigationBar).statusBarHidden(immersive)
                .toolbar{if showClose{ToolbarItem(placement:.cancellationAction){Button("Close"){phone.recordProgress(client,force:true);dismiss()}}}}
                .toolbar{ToolbarItem(placement:.topBarTrailing){Menu{secondaryActions}label:{Image(systemName:"ellipsis").frame(width:44,height:44)}.accessibilityLabel("Playback options")}}
                .onChange(of:scenePhase){_,phase in if phase != .active{phone.recordProgress(client,force:true)}}
                .sheet(isPresented:$outputsPresented){outputSheet}
                .onChange(of:landscape){_,value in if !value{suppressLandscapeFullscreen=false}}
                .onChange(of:immersive){_,value in
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--flyx-ui-fixture"){UIOnlyProtocol.probe(["unifiedPlayerFullscreen":value,"unifiedPlayerPosition":phone.player.currentTime().seconds.isFinite ? phone.player.currentTime().seconds:-1])}
                    #endif
                }
        }.task{await start();
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("switching-e2e40"){UIOnlyProtocol.probe(["switch40ReopenedPlayer":String(describing:ObjectIdentifier(phone.player)),"switch40ReopenedPosition":phone.player.currentTime().seconds.isFinite ? phone.player.currentTime().seconds:-1,"switch40ReopenedPhoneActive":phoneActive])}
            #endif
            await poll()}.onDisappear{phone.recordProgress(client,force:true)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("switching-e2e40"){UIOnlyProtocol.probe(["switch40ClosedPlayer":String(describing:ObjectIdentifier(phone.player)),"switch40ClosedPosition":phone.player.currentTime().seconds.isFinite ? phone.player.currentTime().seconds:-1,"switch40ClosedPhoneReady":phone.ready])}
            #endif
        }
    }}
    private var immersivePlayer:some View {ZStack{PhoneVideoSurface(player:phone.player).ignoresSafeArea();VStack(spacing:16){
        HStack{Button{fullScreen=false;suppressLandscapeFullscreen=true}label:{Image(systemName:"xmark").frame(width:48,height:48).background(.black.opacity(0.7),in:.circle)}.accessibilityLabel("Close fullscreen").accessibilityIdentifier("player.fullscreen.close");Spacer();Button{outputsPresented=true}label:{Label(output,systemImage:outputSymbol).padding(.horizontal,14).frame(minHeight:48).background(.black.opacity(0.7),in:.capsule)}.accessibilityLabel("Playback destination")}
        Spacer();HStack(spacing:36){Button{run{try await action("seek",seconds:max(0,seek-15))}}label:{Image(systemName:"gobackward.15").font(.title).frame(width:52,height:52)}.accessibilityLabel("Back15seconds");Button{run{try await action(playing ? "pause":"resume")}}label:{Image(systemName:playing ? "pause.fill":"play.fill").font(.largeTitle).foregroundStyle(FlyxTheme.ink).frame(width:80,height:80).background(FlyxTheme.accent,in:.circle)}.accessibilityLabel(playing ? "Pause":"Play");Button{run{try await action("seek",seconds:min(duration,seek+15))}}label:{Image(systemName:"goforward.15").font(.title).frame(width:52,height:52)}.accessibilityLabel("Forward15seconds")}.disabled(busy || !phone.ready);Spacer()
        VStack(spacing:12){Slider(value:$seek,in:0...max(1,duration),onEditingChanged:{editing in scrubbing=editing;if !editing{run{try await action("seek",seconds:seek)}}}).accessibilityLabel("Playback position").disabled(busy || duration<=0);HStack{Text(clock(seek));Spacer();Text(clock(duration))}.font(.caption.monospacedDigit());HStack{Button{phone.player.isMuted.toggle()}label:{Image(systemName:phone.player.isMuted ? "speaker.slash.fill":"speaker.wave.2.fill").frame(width:48,height:48)}.accessibilityLabel("Mute current output");Slider(value:$audioVolume,in:0...1,onEditingChanged:{editing in audioScrubbing=editing;if !editing{phone.player.volume=Float(audioVolume)}}).accessibilityLabel("iPhone player volume").accessibilityIdentifier("player.fullscreen.volume")}.disabled(busy)}.padding(16).background(.black.opacity(0.75),in:.rect(cornerRadius:18))
    }.padding(16)}.buttonStyle(.plain)}
    private var receiverList:some View{List{if busy{ProgressView("Finding TVs…")}else if devices.isEmpty{Text("No TVs found. Check that the Mac and TV share a network.").foregroundStyle(.secondary)};ForEach(devices){device in Button(device.name){run{try await switchOutput("tv",receiverID:device.id)}}.disabled(busy || !active)};Button("Refresh receivers"){run{let value=try await client.cast("cast.discover");devices=value.devices ?? []}}.disabled(busy);if let error{Text(error).foregroundStyle(.orange)}}.navigationTitle("Cast to TV").task{guard transferV2 else{return};run{let value=try await client.cast("cast.discover");devices=value.devices ?? []}}}
    private var portrait:some View {ScrollView {VStack(spacing:20){
        Group{if phoneActive{PhoneVideoSurface(player:phone.player).allowsHitTesting(false)}else{RemotePoster(item:nowPlaying)}}
            .frame(height:220).clipShape(.rect(cornerRadius:20))
            .overlay(alignment:.topTrailing){if phoneActive{Button{fullScreen=true}label:{Image(systemName:"arrow.up.left.and.arrow.down.right").frame(width:44,height:44).background(.black.opacity(0.6),in:.circle)}.padding(8).accessibilityLabel("Fullscreen video")}}
        VStack(spacing:6){Text(nowPlaying.title).font(.title2.bold()).multilineTextAlignment(.center).lineLimit(2);Text(active ? (playing ? "Playing on \(output)":"Paused on \(output)"):"Choose a title in Browse to begin.").font(.subheadline).foregroundStyle(.secondary)}.frame(maxWidth:.infinity)
        if active {VStack(spacing:4){
            Label(sourceInfo?.sourceLabel ?? "Source unknown",systemImage:sourceInfo?.origin=="download" ? "internaldrive":"network").font(.subheadline.weight(.medium))
            Text([sourceInfo?.qualityLabel ?? "Quality unknown",resolutionLabel].joined(separator:" · ")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let fallback=sourceInfo?.fallbackLabel{Text(fallback).font(.caption).foregroundStyle(.orange).multilineTextAlignment(.center)}
        }.frame(maxWidth:.infinity).accessibilityElement(children:.combine).accessibilityIdentifier("player.sourceInfo")}
        VStack(spacing:4){Slider(value:$seek,in:0...max(1,duration),onEditingChanged:{editing in scrubbing=editing;if !editing{run{try await action("seek",seconds:seek)}}}).disabled(!active || busy || duration<=0).accessibilityLabel("Playback position");HStack{Text(clock(seek));Spacer();Text(clock(duration))}.font(.caption.monospacedDigit()).foregroundStyle(.secondary)}
        HStack(spacing:36){Button{run{try await action("seek",seconds:max(0,seek-15))}}label:{Image(systemName:"gobackward.15").font(.system(size:29)).frame(width:52,height:60)}.disabled(!active || busy || duration<=0).accessibilityLabel("Back 15 seconds")
            Button{run{try await action(playing ? "pause":"resume")}}label:{ZStack{Circle().fill(FlyxTheme.accent).frame(width:84,height:84);if busy || phone.busy{ProgressView().tint(FlyxTheme.ink)}else{Image(systemName:playing ? "pause.fill":"play.fill").font(.system(size:30,weight:.semibold)).foregroundStyle(FlyxTheme.ink)}}}.disabled(!active || busy || phone.busy).accessibilityLabel(playing ? "Pause":"Play")
            Button{run{try await action("seek",seconds:min(duration,seek+15))}}label:{Image(systemName:"goforward.15").font(.system(size:29)).frame(width:52,height:60)}.disabled(!active || busy || duration<=0).accessibilityLabel("Forward 15 seconds")
        }.buttonStyle(.plain)
        HStack{Button{outputsPresented=true}label:{Label(output,systemImage:outputSymbol).frame(maxWidth:.infinity,minHeight:48)}.buttonStyle(.bordered).accessibilityLabel("Playback destination")
}
        if phoneActive || status?.audioControl==true {HStack{Button{run{if phoneActive{phone.player.isMuted.toggle()}else{let result:CommandResult=try await client.request("/remote/v1/commands",body:JSONEncoder().encode(RemoteMuteAction(output:status?.output ?? "mac",value:status?.isMuted != true)));status=result.status}}}label:{Image(systemName:(phoneActive ? phone.player.isMuted:status?.isMuted==true) ? "speaker.slash.fill":"speaker.wave.2.fill").frame(width:44,height:44)}.disabled(!active || busy).accessibilityLabel("Mute current output")
            Slider(value:$audioVolume,in:0...1,onEditingChanged:{editing in audioScrubbing=editing;if !editing{run{if phoneActive{phone.player.volume=Float(audioVolume)}else{let result:CommandResult=try await client.request("/remote/v1/commands",body:JSONEncoder().encode(RemoteVolumeAction(output:status?.output ?? "mac",value:audioVolume)));status=result.status}}}}).disabled(!active || busy).accessibilityLabel("\(output) player volume")}}

        if busy || phone.busy{ProgressView("Preparing destination…")}
        if let message=error ?? phone.error ?? phone.progress.warning{Text(message).font(.footnote).foregroundStyle(.orange).frame(maxWidth:.infinity,alignment:.leading)}

    }.padding(24)}}
    @ViewBuilder private var secondaryActions:some View {
        if phoneActive,!phone.sources.isEmpty{Menu{ForEach(phone.sources){source in Button{run{await phone.choose(client,sourceID:source.id);if let error=phone.error{throw RemoteFailure(message:error)}}}label:{if source.id==phone.currentSource{Label(source.label,systemImage:"checkmark")}else{Text(source.label)}}}}label:{Label("Source: \(phone.sources.first{$0.id==phone.currentSource}?.label ?? "Auto")",systemImage:"server.rack")}.disabled(busy || phone.busy)}
        else if macSourcesSupported,!phoneActive,active,status?.output != "tv"{Menu{Button("Refresh sources"){run{try await loadMacSources()}};ForEach(macSources){source in Button{run{let _:CommandResult=try await client.request("/remote/v1/sources",body:JSONEncoder().encode(MacSourceOperation(operation:"select",sourceID:source.id)));try await loadMacSources();await refresh()}}label:{if source.selected{Label(source.label,systemImage:"checkmark")}else{Text(source.label)}}}}label:{Label("Provider & quality",systemImage:"slider.horizontal.3")}.disabled(busy)}

        Button("Stop playback",systemImage:"stop.fill"){run{try await action("stop")}}.disabled(!active || busy)
        if status?.audioControl==false{Text("Audio changes are locked by the Mac silent playback setting.")}
    }
    private var outputSheet:some View {NavigationStack{List{
        Section("Playback destination"){
            Button{run{try await switchToMac()}}label:{Label("Mac",systemImage:"desktopcomputer")}.disabled(busy || (!phoneActive && !(transferV2 && status?.output=="tv")))
            Button{run{try await switchToPhone()}}label:{Label("This iPhone",systemImage:"iphone")}.disabled(busy || !active || phoneActive || (!transferV2 && (status?.output=="tv" || (!startsOnPhone && status?.phonePlayback != true))))
            Button{receiverPicker=true}label:{Label("Cast to TV",systemImage:"tv")}.disabled(busy || !active || !transferV2 || (!phoneActive && status?.output=="tv")).accessibilityIdentifier("player.cast")
            if status?.output=="tv",!transferV2{Text("TV → Mac/iPhone handoff is not supported by this installed bridge. The TV remains unchanged.").font(.footnote).foregroundStyle(.secondary)}
        }
        if !transferV2{Text("Cast transfers are unavailable on this Mac bridge.").font(.footnote).foregroundStyle(.secondary)}
        if let error{Text(error).foregroundStyle(.orange)}
    }.navigationTitle("Playback destination").navigationBarTitleDisplayMode(.inline)
    .navigationDestination(isPresented:$receiverPicker){receiverList}
    .toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("switching-e2e40"){UIOnlyProtocol.probe(["switch40DoneWhileBusy":busy,"switch40DoneWhilePending":transfer.pending])}
        #endif
        outputsPresented=false}};if transfer.pending{ToolbarItem(placement:.cancellationAction){Button("Cancel transfer"){cancelWork()}}}}}}
    private func start()async {
        struct Features:Decodable{var features:[String]?}
        if let value:Features=try? await client.request("/remote/v1/info"){transferV2=value.features?.contains("player.transfer.confirm.v2")==true;macSourcesSupported=value.features?.contains("player.sources.v1")==true;phone.progress.enabled=value.features?.contains("player.progress.v1")==true}
        if startsOnPhone,!session.handledPresentations.contains(presentationID){guard !busy else{return};session.handledPresentations.insert(presentationID);session.epoch+=1;busy=true;await phone.prepare(client,selection:initialSelection,position:initialPosition);busy=false;if phone.ready{phoneActive=true;session.phoneArtwork=initialItem?.posterURL}else{error=phone.error};session.epoch+=1}
    }
    private func switchToPhone()async throws {
        if transferV2{try await switchOutput("phone");return}
        guard status?.output != "tv" else{throw RemoteFailure(message:"TV → iPhone transfer is not supported by this bridge.")}
        await phone.prepare(client);guard phone.ready else{throw RemoteFailure(message:phone.error ?? "iPhone preparation failed. The current output is unchanged.")};phoneActive=true;outputsPresented=false;await refresh()
    }
    private func switchToMac()async throws {
        if transferV2{try await switchOutput("mac");return}
        guard phoneActive else{throw RemoteFailure(message:"TV → Mac transfer requires the new Mac transfer bridge.")}
        guard await phone.returnToMac(client) else{throw RemoteFailure(message:phone.error ?? "Mac did not confirm the transfer. iPhone playback continues.")}
        phone.stop(client);phoneActive=false;outputsPresented=false;await refresh()
    }
    private func loadMacSources()async throws{let value:MacSourceInventory=try await client.request("/remote/v1/sources",body:JSONEncoder().encode(MacSourceOperation(operation:"list")));macSources=value.items}
    private func switchOutput(_ destination:String,receiverID:String?=nil)async throws {
        try await session.switchOutput(client,to:destination,receiverID:receiverID)
        outputsPresented=false;await refresh()
    }
    private func cancelWork(){session.cancel(client)}
    private func action(_ type:String,seconds:Double?=nil)async throws {
        if phoneActive {
            switch type {case "pause":phone.player.pause();case "resume":phone.player.play();case "stop":phone.player.pause();guard await phone.player.seek(to:.zero) else{throw RemoteFailure(message:"iPhone seek failed.")};case "seek":guard let seconds,await phone.player.seek(to:CMTime(seconds:max(0,min(duration,seconds)),preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) else{throw RemoteFailure(message:"iPhone seek failed.")};default:throw RemoteFailure(message:"Unsupported player control.")}
        }else{status=try await client.action(type,seconds:seconds).status}
        if phoneActive{phone.recordProgress(client,force:true)}
        await refresh()
    }
    private func refresh()async {
        if phoneActive {phone.recordProgress(client);if !scrubbing{let value=phone.player.currentTime().seconds;if value.isFinite{seek=max(0,value)}};if !audioScrubbing{audioVolume=Double(phone.player.volume)};return}
        guard !busy,!session.refreshInFlight else{return};let epoch=session.epoch;session.refreshInFlight=true;defer{session.refreshInFlight=false}
        do{let value:PlaybackStatus=try await client.request("/remote/v1/status");guard epoch==session.epoch,!phoneActive,!busy,!Task.isCancelled else{return};status=value;error=nil;if !scrubbing{seek=value.position};if !audioScrubbing{audioVolume=value.volume ?? 0}}catch{if epoch==session.epoch,!phoneActive,!busy,!Task.isCancelled{self.error="Mac unavailable. Keep Flyx open; reconnecting…"}}
    }
    private func poll()async{while !Task.isCancelled{await refresh();do{try await Task.sleep(for:.milliseconds(phoneActive ? 500:2000))}catch{return}}}
    private func run(_ work:@escaping @MainActor ()async throws->Void){session.run(work)}
    private func clock(_ seconds:Double)->String{let total=seconds.isFinite ? max(0,Int(seconds)):0;return String(format:"%d:%02d",total/60,total%60)}
}
