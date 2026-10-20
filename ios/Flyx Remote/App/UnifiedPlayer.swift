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
    var initialPresentationID:UUID?=nil
    var showClose=false
    @Environment(\.applicationMode) private var applicationMode
    @State private var modeSettings=false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.playbackSession) private var sharedSession
    @State private var localSession=PlaybackSession()
    @State private var localPresentationID=UUID()
    private var presentationID:UUID{initialPresentationID ?? localPresentationID}
    private var initialPhoneRequest:Bool{startsOnPhone && !session.handledPresentations.contains(presentationID)}
    private var displayedOutput:String{session.displayedOutput(initialPhoneRequest:initialPhoneRequest)}
    private var preparing:Bool{session.preparingOutput != nil || initialPhoneRequest || (phoneActive && phone.busy)}
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
    @State private var audioMuted=false
    @State private var volumePresented=false
    @State private var captionsPresented=false
    @State private var outputsPresented=false
    @State private var directCastPresented=false
    @State private var fullScreen=false
    @State private var fullscreenControls=FullscreenControls()
    @State private var fullscreenActivity=FullscreenPlayerActivity()
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var switchControl=UIAccessibility.isSwitchControlRunning
    @State private var suppressLandscapeFullscreen=false
    @State private var devices:[RemoteCastDevice]=[]
    private var transferV2:Bool{get{session.transferV2}nonmutating set{session.transferV2=newValue}}
    private var macSourcesSupported:Bool{get{session.macSourcesSupported}nonmutating set{session.macSourcesSupported=newValue}}
    private var macSources:[MacSourceChoice]{get{session.macSources}nonmutating set{session.macSources=newValue}}
    private var transfer:DestinationTransferModel{session.transfer}
    @State private var receiverPicker=false
    private var workTask:Task<Void,Never>?{get{session.workTask}nonmutating set{session.workTask=newValue}}
    private var active:Bool{preparing ? false:(phoneActive ? phone.ready:session.connectionMessage==nil && status?.state != nil && status?.state != "idle")}
    private var playing:Bool{phoneActive ? phone.player.rate>0:status?.state=="playing"}
    private var duration:Double{let value=phoneActive ? phone.player.currentItem?.duration.seconds:status?.duration;return value?.isFinite==true ? max(0,value!):0}
    private var output:String{displayedOutput=="phone" ? "This iPhone":displayedOutput=="tv" ? (status?.output=="tv" ? status?.outputName ?? "TV":"TV"):"Mac"}
    private var outputSymbol:String{displayedOutput=="phone" ? "iphone":displayedOutput=="tv" ? "tv":"desktopcomputer"}
    private var sourceInfo:PlaybackSourceInfo?{preparing ? nil:(phoneActive ? phone.sourceInfo:status?.sourceInfo)}
    private var resolutionLabel:String {
        let size=phoneActive ? phone.player.currentItem?.presentationSize:nil
        let width=phoneActive ? size.map{Double($0.width)}:status?.videoWidth.map{Double($0)}
        let height=phoneActive ? size.map{Double($0.height)}:status?.videoHeight.map{Double($0)}
        guard let width,let height,width.isFinite,height.isFinite,width>0,height>0,width<=16384,height<=16384 else{return "Resolution unknown"}
        return "\(Int(width)) × \(Int(height)) decoded"
    }
    private var nowPlaying:RemoteTitle{if initialPhoneRequest{return initialItem ?? RemoteTitle(id:"requested-phone",kind:"movie",title:"This iPhone",overview:"",posterURL:nil)};return phoneActive ? RemoteTitle(id:"current-phone",kind:"movie",title:phone.title,overview:"",posterURL:session.phoneArtwork):RemoteTitle(id:"current-remote",kind:"movie",title:status?.title ?? initialItem?.title ?? "Nothing playing",overview:"",posterURL:status?.artworkURL ?? initialItem?.posterURL)}
    var body:some View {GeometryReader{geometry in
        let landscape=UIDevice.current.userInterfaceIdiom == .phone && geometry.size.width>geometry.size.height
        let immersive=phoneActive && (fullScreen || (landscape && !suppressLandscapeFullscreen))
        NavigationStack {
            Group {
                if immersive {immersivePlayer(landscape:landscape)}
                else {portrait}
            }.background(.black).navigationTitle("Now Playing").navigationBarTitleDisplayMode(.inline)
                .toolbar(immersive ? .hidden:.visible,for:.navigationBar).statusBarHidden(immersive).toolbar(immersive ? .hidden:.visible,for:.tabBar)
                .toolbar{if showClose{ToolbarItem(placement:.cancellationAction){Button("Close"){phone.recordProgress(client,force:true);dismiss()}}}}
                .toolbar{ToolbarItem(placement:.topBarTrailing){Menu{secondaryActions}label:{Image(systemName:"ellipsis").frame(width:44,height:44)}.accessibilityLabel("Playback options")}}

                .sheet(isPresented:$captionsPresented){captionsSheet}
                .onChange(of:displayedOutput){_,_ in volumePresented=false;captionsPresented=false;audioScrubbing=false}
                .sheet(isPresented:$modeSettings){if let applicationMode{ApplicationModeSettings(model:applicationMode)}}
                .sheet(isPresented:$outputsPresented){outputSheet}
                .sheet(isPresented:$directCastPresented){StandaloneCastSheet(client:client,phone:phone,model:session.directCast){phoneActive=false;status=PlaybackStatus(state:session.directCast.paused ? "paused":"playing",position:session.directCast.position,duration:session.directCast.duration,title:phone.title,output:"tv",outputName:session.directCast.receiverName)}}
                .onChange(of:landscape){_,value in if !value{suppressLandscapeFullscreen=false}}
                .onChange(of:FullscreenControls.Context(active:immersive && scenePhase == .active,playing:fullscreenActivity.playing,blocked:preparing || busy || !phone.ready || scrubbing || audioScrubbing || volumePresented || captionsPresented || outputsPresented || modeSettings || directCastPresented || error != nil || phone.error != nil,accessible:voiceOver || switchControl),initial:true){_,context in fullscreenControls.update(context)}
                .onReceive(NotificationCenter.default.publisher(for:UIAccessibility.switchControlStatusDidChangeNotification)){_ in switchControl=UIAccessibility.isSwitchControlRunning}
                .onChange(of:immersive){_,value in
                    if !value{scrubbing=false;audioScrubbing=false;volumePresented=false;captionsPresented=false;fullscreenControls.stop()}
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--flyx-ui-fixture"){UIOnlyProtocol.probe(["unifiedPlayerFullscreen":value,"unifiedPlayerPosition":phone.player.currentTime().seconds.isFinite ? phone.player.currentTime().seconds:-1])}
                    #endif
                }
        }.onAppear{fullscreenActivity.observe(phone.player)}.task{await start();
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("captions-fullscreen71"){fullScreen=true}
            if ProcessInfo.processInfo.arguments.contains("--flyx-ui-fixture"),ProcessInfo.processInfo.arguments.contains("captions-fullscreen71"),let scene=UIApplication.shared.connectedScenes.compactMap({$0 as? UIWindowScene}).first{
                scene.requestGeometryUpdate(.iOS(interfaceOrientations:ProcessInfo.processInfo.arguments.contains("--landscape74") ? .landscapeRight:.portrait))
            }
            if ProcessInfo.processInfo.arguments.contains("--captions-open71"){captionsPresented=true}
            if ProcessInfo.processInfo.arguments.contains("switching-e2e40"){UIOnlyProtocol.probe(["switch40ReopenedPlayer":String(describing:ObjectIdentifier(phone.player)),"switch40ReopenedPosition":phone.player.currentTime().seconds.isFinite ? phone.player.currentTime().seconds:-1,"switch40ReopenedPhoneActive":phoneActive])}
            #endif
        }.task(id:scenePhase){
            guard scenePhase == .active else{return}
            await session.applicationDidBecomeActive(client)
            await poll()
        }.onChange(of:scenePhase){_,phase in if phase != .active{scrubbing=false;audioScrubbing=false;volumePresented=false;captionsPresented=false;fullscreenControls.stop()};if phase == .background{session.applicationDidBackground(client)}}
        .onDisappear{scrubbing=false;audioScrubbing=false;volumePresented=false;captionsPresented=false;fullscreenControls.stop();fullscreenActivity.stop();phone.recordProgress(client,force:true)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("switching-e2e40"){UIOnlyProtocol.probe(["switch40ClosedPlayer":String(describing:ObjectIdentifier(phone.player)),"switch40ClosedPosition":phone.player.currentTime().seconds.isFinite ? phone.player.currentTime().seconds:-1,"switch40ClosedPhoneReady":phone.ready])}
            #endif
        }
    }}
    private func immersivePlayer(landscape:Bool)->some View {ZStack{
        PhoneVideoSurface(player:phone.player).ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
        VStack(spacing:0){
            LinearGradient(colors:[.black.opacity(0.5),.clear],startPoint:.top,endPoint:.bottom).frame(height:120)
            Spacer(minLength:0)
            LinearGradient(colors:[.clear,.black.opacity(0.5)],startPoint:.top,endPoint:.bottom).frame(height:120)
        }.ignoresSafeArea().opacity(fullscreenControls.visible ? 1:0)
            .animation(reduceMotion ? nil:.easeInOut(duration:0.22),value:fullscreenControls.visible)
            .allowsHitTesting(false).accessibilityHidden(true)
        Color.clear.contentShape(Rectangle()).onTapGesture{fullscreenControls.videoTapped()}
            .accessibilityElement(children:.ignore).accessibilityLabel("Show playback controls").accessibilityAddTraits(.isButton).accessibilityAction{fullscreenControls.reveal()}
        VStack(spacing:16){
        HStack(spacing:12){Button{fullscreenControls.stop();fullScreen=false;suppressLandscapeFullscreen=landscape}label:{Image(systemName:"xmark").frame(width:48,height:48).contentShape(.rect)}.accessibilityLabel("Close fullscreen").accessibilityIdentifier("player.fullscreen.close");Spacer(minLength:12);captionsButton(iconOnly:true);fullscreenVolumeButton;Button{outputsPresented=true}label:{Label(output,systemImage:outputSymbol).padding(.horizontal,8).frame(minHeight:48).contentShape(.rect)}.accessibilityLabel("Playback destination")}.foregroundStyle(.white).shadow(color:.black.opacity(0.75),radius:2,y:1)
        Spacer();HStack(spacing:36){Button{run{try await action("seek",seconds:max(0,seek-15))}}label:{Image(systemName:"gobackward.15").font(.title).frame(width:52,height:52)}.accessibilityLabel("Back15seconds");Button{run{try await action(playing ? "pause":"resume")}}label:{Image(systemName:playing ? "pause.fill":"play.fill").font(.largeTitle).foregroundStyle(FlyxTheme.ink).frame(width:80,height:80).background(FlyxTheme.accent,in:.circle)}.accessibilityLabel(playing ? "Pause":"Play");Button{run{try await action("seek",seconds:min(duration,seek+15))}}label:{Image(systemName:"goforward.15").font(.title).frame(width:52,height:52)}.accessibilityLabel("Forward15seconds")}.shadow(color:.black.opacity(0.75),radius:2,y:1).disabled(busy || preparing || !phone.ready);Spacer()
        VStack(spacing:4){Slider(value:$seek,in:0...max(1,duration),onEditingChanged:{editing in scrubbing=editing;fullscreenControls.interaction("seek",active:editing);if !editing{run{try await action("seek",seconds:seek)}}}).frame(minHeight:44).accessibilityLabel("Playback position").accessibilityIdentifier("player.fullscreen.seek").disabled(busy || preparing || duration<=0);HStack{Text(clock(seek));Spacer();Text(clock(duration))}.font(.caption.monospacedDigit())}.padding(.horizontal,12).padding(.vertical,8).shadow(color:.black.opacity(0.75),radius:2,y:1)
        if preparing || phone.busy{ProgressView("Preparing on This iPhone…")}
        else if fullscreenActivity.waiting{ProgressView("Buffering…")}
        if let message=error ?? phone.error{Text(message).font(.footnote).foregroundStyle(.orange).padding(12).background(.black.opacity(0.75),in:.rect(cornerRadius:12))}
    }.padding(16).opacity(fullscreenControls.visible ? 1:0)
        .animation(reduceMotion ? nil:.easeInOut(duration:0.22),value:fullscreenControls.visible)
        .allowsHitTesting(fullscreenControls.visible).accessibilityHidden(!fullscreenControls.visible)
    }.buttonStyle(FullscreenButtonStyle(controls:fullscreenControls))}
    private var receiverList:some View{List{if busy{ProgressView("Finding TVs…")}else if devices.isEmpty{Text("No TVs found. Check that the Mac and TV share a network.").foregroundStyle(.secondary)};ForEach(devices){device in Button(device.name){run{try await switchOutput("tv",receiverID:device.id)}}.disabled(busy || preparing || !active)};Button("Refresh receivers"){run{let value=try await client.cast("cast.discover");devices=value.devices ?? []}}.disabled(busy || preparing);if let error{Text(error).foregroundStyle(.orange)}}.navigationTitle("Cast to TV").task{guard transferV2 else{return};run{let value=try await client.cast("cast.discover");devices=value.devices ?? []}}}
    private var portrait:some View {ScrollView {VStack(spacing:20){
        Group{if phoneActive{PhoneVideoSurface(player:phone.player).allowsHitTesting(false)}else{RemotePoster(item:nowPlaying)}}
            .frame(height:220).clipShape(.rect(cornerRadius:20))
            .overlay(alignment:.topTrailing){if phoneActive{Button{fullScreen=true}label:{Image(systemName:"arrow.up.left.and.arrow.down.right").frame(width:44,height:44).background(.black.opacity(0.6),in:.circle)}.padding(8).accessibilityLabel("Fullscreen video")}}
        VStack(spacing:6){Text(nowPlaying.title).font(.title2.bold()).multilineTextAlignment(.center).lineLimit(2);Text(preparing ? "Preparing on \(output)…":active ? (playing ? "Playing on \(output)":"Paused on \(output)"):phoneActive ? "Not playing on This iPhone":"Choose a title in Browse to begin.").font(.subheadline).foregroundStyle(.secondary)}.frame(maxWidth:.infinity)
        if active {VStack(spacing:4){
            Label(sourceInfo?.sourceLabel ?? "Source unknown",systemImage:sourceInfo?.origin=="download" ? "internaldrive":"network").font(.subheadline.weight(.medium))
            Text([phoneActive && phone.qualityEnabled ? phone.qualitySummary:(sourceInfo?.qualityLabel ?? "Quality unknown"),resolutionLabel].joined(separator:" · ")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let fallback=sourceInfo?.fallbackLabel{Text(fallback).font(.caption).foregroundStyle(.orange).multilineTextAlignment(.center)}
        }.frame(maxWidth:.infinity).accessibilityElement(children:.combine).accessibilityIdentifier("player.sourceInfo")}
        if phoneActive,phone.qualityEnabled{qualityMenu;if let note=phone.qualityNote{Text(note).font(.caption).foregroundStyle(.secondary)}}
        VStack(spacing:4){Slider(value:$seek,in:0...max(1,duration),onEditingChanged:{editing in scrubbing=editing;if !editing{run{try await action("seek",seconds:seek)}}}).disabled(!active || busy || duration<=0).accessibilityLabel("Playback position");HStack{Text(clock(seek));Spacer();Text(clock(duration))}.font(.caption.monospacedDigit()).foregroundStyle(.secondary)}
        HStack(spacing:36){Button{run{try await action("seek",seconds:max(0,seek-15))}}label:{Image(systemName:"gobackward.15").font(.system(size:29)).frame(width:52,height:60)}.disabled(!active || busy || duration<=0).accessibilityLabel("Back 15 seconds")
            Button{run{try await action(playing ? "pause":"resume")}}label:{ZStack{Circle().fill(FlyxTheme.accent).frame(width:84,height:84);if preparing || busy || phone.busy{ProgressView().tint(FlyxTheme.ink)}else{Image(systemName:playing ? "pause.fill":"play.fill").font(.system(size:30,weight:.semibold)).foregroundStyle(FlyxTheme.ink)}}}.disabled(!active || busy || phone.busy).accessibilityLabel(playing ? "Pause":"Play")
            Button{run{try await action("seek",seconds:min(duration,seek+15))}}label:{Image(systemName:"goforward.15").font(.system(size:29)).frame(width:52,height:60)}.disabled(!active || busy || duration<=0).accessibilityLabel("Forward 15 seconds")
        }.buttonStyle(.plain)
        HStack{Button{outputsPresented=true}label:{Label(output,systemImage:outputSymbol).frame(maxWidth:.infinity,minHeight:48)}.buttonStyle(.bordered).accessibilityLabel("Playback destination")
}
        HStack{captionsButton(iconOnly:false);Spacer();if session.audioAvailable{compactAudio}}


        if preparing || busy || phone.busy{ProgressView(preparing ? "Preparing on \(output)…":"Preparing destination…")}
        if let message=session.connectionMessage,!phoneActive{Text(message).font(.footnote).foregroundStyle(.secondary)}
        if phoneActive,phone.hasForegroundInterruption{Button("Retry this iPhone"){run{await phone.retryForegroundPlayback(client)}}}
        if let message=error ?? phone.error ?? phone.progress.warning{Text(message).font(.footnote).foregroundStyle(.orange).frame(maxWidth:.infinity,alignment:.leading)}

    }.padding(24)}}
    private var captionTracks:[PlaybackCaptionTrack]{phoneActive ? phone.captions.tracks:session.directCast.active ? session.directCast.captionTracks:[]}
    private var selectedCaptionID:String?{phoneActive ? phone.captions.selectedID:session.directCast.active ? session.directCast.selectedCaptionID:nil}
    private var captionsLoading:Bool{phoneActive && phone.captions.loading}
    private var captionIsOff:Bool{phoneActive ? phone.captions.isOff:selectedCaptionID==nil}
    private var captionsAvailable:Bool{phoneActive || session.directCast.active}
    private var captionSelectionLabel:String{phoneActive ? phone.captions.selectionLabel:session.directCast.active ? captionTracks.first{$0.id==selectedCaptionID}?.label ?? "Off":"Unavailable"}
    private func captionsButton(iconOnly:Bool)->some View{
        Button{captionsPresented=true}label:{Label("Subtitles",systemImage:selectedCaptionID==nil ? "captions.bubble":"captions.bubble.fill").labelStyle(PlayerCaptionLabelStyle(iconOnly:iconOnly)).frame(minWidth:44,minHeight:44).contentShape(.rect)}
            .accessibilityLabel("Subtitles and captions").accessibilityValue(captionSelectionLabel).accessibilityIdentifier("player.captions").disabled(!active || busy || preparing)
    }
    private func presentVolume(){audioVolume=session.audioVolume;audioMuted=session.audioMuted;volumePresented=true}
    private func toggleMute(){run{try await session.setMuted(client,!session.audioMuted);await refresh()}}
    private var fullscreenVolumeButton:some View{
        Button{presentVolume()}label:{Image(systemName:audioMuted ? "speaker.slash.fill":"speaker.wave.2.fill").frame(width:44,height:44).contentShape(.rect)}
            .accessibilityLabel("\(output) volume").accessibilityValue(audioMuted ? "Muted":"\(Int(audioVolume*100)) percent")
            .accessibilityHint("Shows the volume slider and mute control")
            .accessibilityAction(named:Text(audioMuted ? "Unmute":"Mute")){toggleMute()}
            .accessibilityIdentifier("player.fullscreen.volume")
            .popover(isPresented:$volumePresented){volumePanel.presentationCompactAdaptation(.popover)}
            .disabled(!active || busy || preparing)
            .task{
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--volume-open71"){try? await Task.sleep(for:.milliseconds(500));volumePresented=true}
                #endif
            }
    }
    private var compactAudio:some View{
        HStack(spacing:0){
            Button{toggleMute()}label:{Image(systemName:audioMuted ? "speaker.slash.fill":"speaker.wave.2.fill").frame(width:44,height:44)}
                .accessibilityLabel("\(audioMuted ? "Unmute":"Mute") \(output)").accessibilityValue(audioMuted ? "Muted":"Sound on").accessibilityIdentifier("player.mute")
            Button{presentVolume()}label:{Image(systemName:"chevron.up").font(.caption.weight(.semibold)).frame(width:44,height:44)}
                .accessibilityLabel("Adjust \(output) volume").accessibilityValue("\(Int(audioVolume*100)) percent").accessibilityIdentifier("player.volume").popover(isPresented:$volumePresented){volumePanel.presentationCompactAdaptation(.popover)}
        }.background(.secondary.opacity(0.15),in:.capsule).disabled(!active || busy || preparing)
        .task{
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--volume-open71"){try? await Task.sleep(for:.milliseconds(500));volumePresented=true}
            #endif
        }
    }
    private var volumePanel:some View{
        VStack(spacing:12){HStack{Text("\(output) volume").font(.headline);Spacer();Button("Done"){volumePresented=false}.accessibilityIdentifier("player.volume.done")}
            HStack{Button{toggleMute()}label:{Label(audioMuted ? "Unmute":"Mute",systemImage:audioMuted ? "speaker.slash.fill":"speaker.wave.2.fill").frame(minHeight:44).contentShape(.rect)}.buttonStyle(.plain).accessibilityLabel("\(audioMuted ? "Unmute":"Mute") \(output)").accessibilityIdentifier("player.volume.mute").disabled(!active || busy || preparing);Spacer();Text("\(Int(audioVolume*100))%").font(.caption.monospacedDigit())}
            Slider(value:$audioVolume,in:0...1,onEditingChanged:{editing in audioScrubbing=editing;fullscreenControls.interaction("volume",active:editing);if !editing{run{try await session.setVolume(client,audioVolume);await refresh()}}})
                .accessibilityLabel("\(output) player volume").accessibilityIdentifier("player.volume.slider").disabled(!active || busy || preparing)
        }.padding(20).frame(width:280).onDisappear{audioScrubbing=false;fullscreenControls.interaction("volume",active:false)}
    }
    private var captionsSheet:some View{NavigationStack{List{
        Section{Button{selectCaption(nil)}label:{captionRow("Off",selected:captionIsOff && captionsAvailable && !captionsLoading)}.disabled(!captionsAvailable || (phoneActive && (!phone.captions.allowsOff || phone.captions.loading)) || busy || preparing).accessibilityIdentifier("player.captions.off")
            ForEach(captionTracks){track in Button{selectCaption(track.id)}label:{captionRow(track.label,selected:selectedCaptionID==track.id)}.disabled(busy || preparing)}
        }header:{Text("\(output) subtitles")}
        if phoneActive,phone.captions.loading{ProgressView("Loading tracks…")}
        if !captionsAvailable{Text("Subtitle controls are unavailable for this destination. Use the player on your Mac or TV.").font(.footnote).foregroundStyle(.secondary)}
        else if captionTracks.isEmpty,!captionsLoading{Text("This source has no selectable subtitle tracks.").font(.footnote).foregroundStyle(.secondary)}
        if phoneActive,let message=phone.captions.message{Text(message).foregroundStyle(.secondary)}
        Text("Off disables selectable subtitles. Text embedded in the video image cannot be removed.").font(.footnote).foregroundStyle(.secondary)
        if let message=error{Text(message).foregroundStyle(.orange)}
        if session.directCast.active{Text(session.directCast.message).font(.footnote).foregroundStyle(.secondary)}
    }.navigationTitle("Subtitles").navigationBarTitleDisplayMode(.inline).toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){captionsPresented=false}}}.presentationDetents([.medium,.large])}}
    private func captionRow(_ label:String,selected:Bool)->some View{HStack{Text(label);Spacer();if selected{Image(systemName:"checkmark").accessibilityHidden(true)}}.accessibilityElement(children:.combine).accessibilityAddTraits(selected ? .isSelected:[])}
    private func selectCaption(_ id:String?){do{if phoneActive{try phone.captions.select(id)}else if session.directCast.active{try session.directCast.selectCaption(id)};error=nil}catch{self.error=error.localizedDescription}}
    private var qualityMenu:some View{
        Menu{
            Button{phone.selectQuality("highest")}label:{Label("Highest available",systemImage:phone.effectiveQualityID=="highest" ? "checkmark":"arrow.up")}
            Button{phone.selectQuality("automatic")}label:{Label("Automatic",systemImage:phone.effectiveQualityID=="automatic" ? "checkmark":"wand.and.stars")}
            ForEach(phone.qualityChoices){choice in Button{phone.selectQuality(choice.id)}label:{Label("Up to \(choice.label)",systemImage:phone.effectiveQualityID==choice.id ? "checkmark":"video")}}
            if phone.qualityChoices.isEmpty{Text("No resolution variants advertised by this source.")}
            Text("Preferences use this source’s variants. Playback may adapt below the requested resolution.")
        }label:{Label("Quality: \(phone.qualitySelectionLabel)",systemImage:"slider.horizontal.3").font(.subheadline).frame(minHeight:44)}.disabled(busy || preparing || phone.busy || !phone.ready).accessibilityIdentifier("player.quality")
    }
    @ViewBuilder private var secondaryActions:some View {
        if phoneActive,phone.qualityEnabled{qualityMenu}
        if applicationMode != nil{Button("Settings",systemImage:"gearshape"){modeSettings=true}}
        if phoneActive,!phone.sources.isEmpty{Menu{ForEach(phone.sources){source in Button{run{await phone.choose(client,sourceID:source.id);if let error=phone.error{throw RemoteFailure(message:error)}}}label:{if source.id==phone.currentSource{Label(source.label,systemImage:"checkmark")}else{Text(source.label)}}}}label:{Label("Source: \(phone.sources.first{$0.id==phone.currentSource}?.label ?? "Auto")",systemImage:"server.rack")}.disabled(busy || preparing || phone.busy)}
        else if macSourcesSupported,!phoneActive,active,status?.output != "tv"{Menu{Button("Refresh sources"){run{try await loadMacSources()}};ForEach(macSources){source in Button{run{let _:CommandResult=try await client.request("/remote/v1/sources",body:JSONEncoder().encode(MacSourceOperation(operation:"select",sourceID:source.id)));try await loadMacSources();await refresh()}}label:{if source.selected{Label(source.label,systemImage:"checkmark")}else{Text(source.label)}}}}label:{Label("Provider & quality",systemImage:"slider.horizontal.3")}.disabled(busy || preparing)}

        Button("Stop playback",systemImage:"stop.fill"){run{try await action("stop")}}.disabled(!active || busy)
        if status?.audioControl==false{Text("Audio changes are locked by the Mac silent playback setting.")}
    }
    private var outputSheet:some View {NavigationStack{List{
        Section("Playback destination"){
            if !client.isStandalone{Button{run{try await switchToMac()}}label:{Label("Mac",systemImage:"desktopcomputer")}.disabled(busy || preparing || (!phoneActive && !(transferV2 && status?.output=="tv")))}
            Button{run{try await switchToPhone()}}label:{Label("This iPhone",systemImage:"iphone")}.disabled(busy || preparing || !active || phoneActive || (!client.isStandalone && !transferV2 && (status?.output=="tv" || (!startsOnPhone && status?.phonePlayback != true))))
            if client.isStandalone{Button{outputsPresented=false;directCastPresented=true}label:{Label("Cast to TV",systemImage:"tv")}.disabled(busy || preparing || !phone.ready || session.directCast.active).accessibilityIdentifier("player.cast.direct")}
            if !client.isStandalone{Button{receiverPicker=true}label:{Label("Cast to TV",systemImage:"tv")}.disabled(busy || preparing || !active || !transferV2 || (!phoneActive && status?.output=="tv")).accessibilityIdentifier("player.cast")}
            if status?.output=="tv",!transferV2{Text("TV → Mac/iPhone handoff is not supported by this installed bridge. The TV remains unchanged.").font(.footnote).foregroundStyle(.secondary)}
        }
        if !transferV2,!client.isStandalone{Text("Cast transfers are unavailable on this Mac bridge.").font(.footnote).foregroundStyle(.secondary)}
        if let error{Text(error).foregroundStyle(.orange)}
    }.navigationTitle("Playback destination").navigationBarTitleDisplayMode(.inline)
    .navigationDestination(isPresented:$receiverPicker){receiverList}
    .toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("switching-e2e40"){UIOnlyProtocol.probe(["switch40DoneWhileBusy":busy,"switch40DoneWhilePending":transfer.pending])}
        #endif
        outputsPresented=false}};if transfer.pending || (session.preparingOutput=="phone" && phoneActive){ToolbarItem(placement:.cancellationAction){Button(transfer.pending ? "Cancel transfer":"Cancel preparation"){cancelWork()}}}}}}
    private func start()async {
        if startsOnPhone{session.startPhone(client,presentationID:presentationID,selection:initialSelection,position:initialPosition,item:initialItem)}
        // Capability discovery never delays selecting/preparing the phone destination.
        struct Features:Decodable{var features:[String]?}
        if let value:Features=try? await client.request("/remote/v1/info"),!Task.isCancelled{transferV2=value.features?.contains("player.transfer.confirm.v2")==true;macSourcesSupported=value.features?.contains("player.sources.v1")==true;phone.progress.enabled=value.features?.contains("player.progress.v1")==true}
    }
    private func switchToPhone()async throws {
        if client.isStandalone,session.directCast.active{let position=session.directCast.position,paused=session.directCast.paused;session.directCast.end();guard await phone.player.seek(to:CMTime(seconds:position,preferredTimescale:600)) else{throw RemoteFailure(message:"Could not restore TV position on iPhone.")};phone.suppressLocalProgress=false;if !paused{phone.player.play()};phoneActive=true;outputsPresented=false;return}
        if transferV2{try await switchOutput("phone");return}
        try await session.switchLegacyOutput(client,to:"phone");outputsPresented=false;await refresh()
    }
    private func switchToMac()async throws {
        if transferV2{try await switchOutput("mac");return}
        try await session.switchLegacyOutput(client,to:"mac");outputsPresented=false;await refresh()
    }
    private func loadMacSources()async throws{let value:MacSourceInventory=try await client.request("/remote/v1/sources",body:JSONEncoder().encode(MacSourceOperation(operation:"list")));macSources=value.items}
    private func switchOutput(_ destination:String,receiverID:String?=nil)async throws {
        try await session.switchOutput(client,to:destination,receiverID:receiverID)
        outputsPresented=false;await refresh()
    }
    private func cancelWork(){session.cancel(client)}
    private func action(_ type:String,seconds:Double?=nil)async throws {
        try await session.playbackAction(client,type,seconds:seconds)
        await refresh()
    }
    private func refresh()async {
        if client.isStandalone,!session.directCast.active,!session.directCast.connecting,phone.ready,!phoneActive{if phone.suppressLocalProgress{_ = await phone.player.seek(to:CMTime(seconds:session.directCast.position,preferredTimescale:600));phone.player.pause()};phoneActive=true;phone.suppressLocalProgress=false}
        if client.isStandalone,session.directCast.active{let cast=session.directCast;if !audioScrubbing{audioVolume=cast.volume;audioMuted=cast.muted};phone.recordCastProgress(client,position:cast.position,duration:cast.duration);status=PlaybackStatus(state:cast.paused ? "paused":"playing",position:cast.position,duration:cast.duration,title:phone.title,output:"tv",outputName:cast.receiverName);if !scrubbing{seek=cast.position};return}
        if phoneActive {phone.recordProgress(client);if !scrubbing{let value=phone.player.currentTime().seconds;if value.isFinite{seek=max(0,value)}};if !audioScrubbing{audioVolume=Double(phone.player.volume);audioMuted=phone.player.isMuted};return}
        await session.refreshRemoteStatus(client)
        if session.connectionMessage==nil,let value=status{if !scrubbing{seek=value.position};if !audioScrubbing{audioVolume=value.volume ?? 0;audioMuted=value.isMuted==true}}
    }
    private func poll()async{while !Task.isCancelled{await refresh();do{try await Task.sleep(for:.milliseconds(phoneActive ? 500:2000))}catch{return}}}
    private func run(_ work:@escaping @MainActor ()async throws->Void){session.run(work)}
    private func clock(_ seconds:Double)->String{let total=seconds.isFinite ? max(0,Int(seconds)):0;return String(format:"%d:%02d",total/60,total%60)}
}

private struct PlayerCaptionLabelStyle:LabelStyle {
    let iconOnly:Bool
    func makeBody(configuration:Configuration)->some View{HStack{configuration.icon;if !iconOnly{configuration.title}}}
}
