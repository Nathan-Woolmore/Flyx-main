import SwiftUI
@preconcurrency import AVFoundation

/// Video rendering only. All controls belong to the shared Flyx surface, so
/// AVKit cannot place a second volume/fullscreen layer over its buttons.
struct PhoneVideoSurface:UIViewRepresentable {
    let player:AVPlayer
    final class Surface:UIView {
        override class var layerClass:AnyClass{AVPlayerLayer.self}
        var videoLayer:AVPlayerLayer{layer as! AVPlayerLayer}
    }
    func makeUIView(context:Context)->Surface{let view=Surface();view.backgroundColor = .black;view.videoLayer.videoGravity = .resizeAspect;view.videoLayer.player=player;return view}
    func updateUIView(_ view:Surface,context:Context){view.videoLayer.player=player}
    static func dismantleUIView(_ view:Surface,coordinator:()){view.videoLayer.player=nil}
}

import Observation

/// One cancellable idle deadline for the existing Flyx overlay; never a second AVKit control layer.
@MainActor @Observable final class FullscreenControls {
    struct Context:Equatable {var active=false;var playing=false;var blocked=false;var accessible=false}
    private(set) var visible=true
    private(set) var context=Context()
    private var interactions=Set<String>()
    private let delay:Duration
    @ObservationIgnored private var hideTask:Task<Void,Never>?
    private var generation=0
    var canHide:Bool{context.active && context.playing && !context.blocked && !context.accessible && interactions.isEmpty}
    var timerScheduled:Bool{hideTask != nil}
    init(delay:Duration = .seconds(3)){self.delay=delay}
    private func cancelTimer(){generation+=1;hideTask?.cancel();hideTask=nil}
    private func schedule(){
        cancelTimer();guard visible,canHide else{return}
        let ticket=generation,delay=delay
        hideTask=Task{[weak self] in
            do{try await Task.sleep(for:delay)}catch{return}
            guard let self,!Task.isCancelled,self.generation==ticket,self.canHide else{return}
            self.visible=false;self.hideTask=nil
        }
    }
    func update(_ next:Context){guard context != next else{return};context=next
        if !next.active{interactions.removeAll();cancelTimer();visible=true}
        else if !canHide{cancelTimer();visible=true}
        else{visible=true;schedule()}
    }
    func reveal(){visible=true;schedule()}
    func videoTapped(){if visible,canHide{cancelTimer();visible=false}else{reveal()}}
    func interaction(_ id:String,active:Bool){if active{interactions.insert(id)}else{interactions.remove(id)};visible=true;schedule()}
    func stop(){cancelTimer();interactions.removeAll();context=Context();visible=true}
}

/// AVPlayer is not Observable. KVO reports pause, buffering and item replacement without polling a backend.
@MainActor @Observable final class FullscreenPlayerActivity {
    private(set) var playing=false
    private(set) var waiting=false
    @ObservationIgnored private var timeObservation:NSKeyValueObservation?
    @ObservationIgnored private var itemObservation:NSKeyValueObservation?
    @ObservationIgnored private var statusObservation:NSKeyValueObservation?
    @ObservationIgnored private weak var player:AVPlayer?
    private var generation=0
    private func refresh(){guard let player else{playing=false;waiting=false;return};waiting=player.timeControlStatus == .waitingToPlayAtSpecifiedRate;playing=player.timeControlStatus == .playing && player.currentItem?.status == .readyToPlay && player.currentItem?.error==nil}
    private func observeItem(){statusObservation?.invalidate();guard let item=player?.currentItem else{refresh();return};let ticket=generation
        statusObservation=item.observe(\.status,options:[.initial,.new]){[weak self,weak item] _,_ in Task{@MainActor in guard let self,self.generation==ticket,self.player?.currentItem === item else{return};self.refresh()}}
        refresh()
    }
    func observe(_ player:AVPlayer){guard self.player !== player else{return};stop();self.player=player;let ticket=generation
        timeObservation=player.observe(\.timeControlStatus,options:[.initial,.new]){[weak self] _,_ in Task{@MainActor in guard let self,self.generation==ticket else{return};self.refresh()}}
        itemObservation=player.observe(\.currentItem,options:[.initial,.new]){[weak self] _,_ in Task{@MainActor in guard let self,self.generation==ticket else{return};self.observeItem()}}
    }
    func stop(){generation+=1;timeObservation?.invalidate();itemObservation?.invalidate();statusObservation?.invalidate();timeObservation=nil;itemObservation=nil;statusObservation=nil;player=nil;playing=false;waiting=false}
}
@MainActor struct FullscreenButtonStyle:ButtonStyle {
    let controls:FullscreenControls
    func makeBody(configuration:Configuration)->some View{Pressed(configuration:configuration,controls:controls)}
    private struct Pressed:View {
        let configuration:ButtonStyleConfiguration;let controls:FullscreenControls
        @State private var token=UUID().uuidString
        var body:some View{configuration.label.onChange(of:configuration.isPressed){_,pressed in controls.interaction(token,active:pressed)}.onDisappear{controls.interaction(token,active:false)}}
    }
}


struct PlaybackCaptionTrack:Identifiable,Equatable {let id:String;let label:String}

/// Owns only the legible selection. Audio-language selection stays automatic.
/// Selections are read back from AVFoundation, never inferred from a tapped button.
@MainActor @Observable final class NativeCaptionsModel {
    private(set) var tracks:[PlaybackCaptionTrack]=[]
    private(set) var selectedID:String?
    private(set) var isOff=true
    private(set) var failed=false
    private(set) var loading=false
    private(set) var message:String?
    var allowsOff:Bool{group?.allowsEmptySelection ?? (!loading && !failed)}
    var selectionLabel:String{loading ? "Loading…":failed ? "Unavailable":isOff ? "Off":tracks.first{$0.id==selectedID}?.label ?? "Current track"}
    @ObservationIgnored private weak var item:AVPlayerItem?
    @ObservationIgnored private var group:AVMediaSelectionGroup?
    @ObservationIgnored private var options:[String:AVMediaSelectionOption]=[:]
    @ObservationIgnored private var notification:NSObjectProtocol?
    private var generation=0
    private var overrideOff=false
    private var preferredTrack:String?
    func resetPreference(){overrideOff=false;preferredTrack=nil}
    func attach(_ item:AVPlayerItem?){
        generation+=1;let ticket=generation
        if let notification{NotificationCenter.default.removeObserver(notification)};notification=nil
        self.item=item;group=nil;options=[:];tracks=[];selectedID=nil;isOff=true;failed=false;message=nil;loading=item != nil
        guard let item else{return}
        notification=NotificationCenter.default.addObserver(forName:AVPlayerItem.mediaSelectionDidChangeNotification,object:item,queue:.main){[weak self,weak item] _ in Task{@MainActor in guard let self,self.generation==ticket,self.item === item else{return};self.refresh()}}
        Task{[weak self,weak item] in
            guard let item else{return}
            do{
                let group=try await item.asset.loadMediaSelectionGroup(for:.legible)
                guard let self,self.generation==ticket,self.item === item else{return}
                self.loading=false;self.group=group
                if let group{
                    for option in group.options where option.isPlayable{let id=UUID().uuidString;self.options[id]=option;self.tracks.append(.init(id:id,label:option.displayName))}
                    if self.overrideOff,group.allowsEmptySelection{item.select(nil,in:group)}
                    else if let preferred=self.preferredTrack,let option=group.options.first(where:{$0.displayName==preferred && $0.isPlayable}){item.select(option,in:group)}
                    if !group.allowsEmptySelection{self.message="This source requires its subtitle track; Off is unavailable."}
                }
                self.refresh()
            }catch{guard let self,self.generation==ticket else{return};self.loading=false;self.failed=true;self.message="Subtitle tracks could not be loaded."}
        }
    }
    private func refresh(){guard let item,let group else{selectedID=nil;isOff=true;return};let selected=item.currentMediaSelection.selectedMediaOption(in:group);isOff=selected==nil;selectedID=options.first{$0.value==selected}?.key}
    func select(_ id:String?)throws{
        guard !loading,!failed,let item else{throw RemoteFailure(message:"Subtitle tracks are not ready.")}
        guard let group else{if id==nil{overrideOff=true;preferredTrack=nil;return};throw RemoteFailure(message:"This track is no longer available.")}
        if let id{guard let option=options[id] else{throw RemoteFailure(message:"This track is no longer available.")};overrideOff=false;preferredTrack=option.displayName;item.select(option,in:group)}
        else{guard group.allowsEmptySelection else{throw RemoteFailure(message:"This source does not allow subtitles to be turned off.")};overrideOff=true;preferredTrack=nil;item.select(nil,in:group)}
        refresh()
    }
}
