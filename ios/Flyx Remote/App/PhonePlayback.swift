import SwiftUI
@preconcurrency import AVKit
import Observation

struct PhonePlaybackSelection:Codable,Hashable,Identifiable,Sendable {let kind:String;let contentID:Int;let season:Int?;let episode:Int?;var id:String{"\(kind):\(contentID):\(season ?? 1):\(episode ?? 1)"}}
struct PhoneMediaOperation:Encodable {let operation:String;var handle:String?;var offset:Int64?;var length:Int?;var position:Double?;var paused:Bool?;var selection:PhonePlaybackSelection?;var resourceID:String?;var range:String?;var sourceID:String?}
struct PhoneMediaGrant:Decodable,Sendable {let handle:String;let title:String;let position:Double;let duration:Double;let paused:Bool;let format:String;var mode:String?;var currentSource:String?;var sources:[PhoneSource]?;var sourceInfo:PlaybackSourceInfo?}
struct PhoneSource:Decodable,Identifiable,Sendable {let id:String;let provider:String;let quality:String;let language:String;let format:String;var label:String{[provider,quality,language.uppercased()].filter{!$0.isEmpty}.joined(separator:" · ")}}
struct PhoneMediaChunk:Decodable,Sendable {let bytes:Data;let total:Int64;let offset:Int64}
// AVFoundation request objects are confined to queue. Network tasks exchange
// immutable range values; unchecked Sendable can be removed when AVFoundation
// exposes a Sendable resource-loading request.
private final class MediaLoadingBox:@unchecked Sendable {let request:AVAssetResourceLoadingRequest;init(_ request:AVAssetResourceLoadingRequest){self.request=request}}
final class PairedMediaLoader:NSObject,AVAssetResourceLoaderDelegate,@unchecked Sendable {
    let queue=DispatchQueue(label:"local.flyx.remote.media")
    private let client:RemoteClient
    private let handle:String
    let assetURL=URL(string:"flyx-media://asset/"+UUID().uuidString+"/movie.mp4")!
    private var tasks:[ObjectIdentifier:Task<Void,Never>]=[:]
    private var stopped=false
    init(client:RemoteClient,handle:String){self.client=client;self.handle=handle}
    func resourceLoader(_ resourceLoader:AVAssetResourceLoader,shouldWaitForLoadingOfRequestedResource request:AVAssetResourceLoadingRequest)->Bool {
        guard !stopped,request.request.url==assetURL else{return false}
        let box=MediaLoadingBox(request),key=ObjectIdentifier(request)
        let start=max(request.dataRequest?.currentOffset ?? 0,request.dataRequest?.requestedOffset ?? 0)
        let length=max(2,request.dataRequest?.requestedLength ?? 2),wantsData=request.dataRequest != nil
        tasks[key]=Task { [self,box] in
            do {
                var offset=start,remaining=length
                while remaining>0 {
                    try Task.checkCancellation()
                    let chunk:PhoneMediaChunk=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"chunk",handle:handle,offset:offset,length:min(1_048_576,remaining))))
                    try Task.checkCancellation()
                    guard chunk.offset==offset,!chunk.bytes.isEmpty,chunk.bytes.count<=1_048_576,chunk.total>offset else{throw RemoteFailure(message:"The Mac returned an invalid media range.")}
                    queue.sync {
                        guard !stopped,!box.request.isCancelled else{return}
                        if let info=box.request.contentInformationRequest{info.contentType="public.mpeg-4";info.contentLength=chunk.total;info.isByteRangeAccessSupported=true}
                        box.request.dataRequest?.respond(with:chunk.bytes)
                    }
                    offset+=Int64(chunk.bytes.count);remaining-=chunk.bytes.count
                    if !wantsData || offset>=chunk.total{break}
                }
                queue.async{if !self.stopped && !box.request.isCancelled{box.request.finishLoading()};self.tasks.removeValue(forKey:key)}
            }catch{queue.async{if !self.stopped && !box.request.isCancelled{box.request.finishLoading(with:error)};self.tasks.removeValue(forKey:key)}}
        }
        return true
    }
    func resourceLoader(_ resourceLoader:AVAssetResourceLoader,didCancel request:AVAssetResourceLoadingRequest){tasks.removeValue(forKey:ObjectIdentifier(request))?.cancel()}
    func cancelAll(){queue.async{self.stopped=true;self.tasks.values.forEach{$0.cancel()};self.tasks.removeAll()}}
}
struct PhoneQualityChoice:Identifiable,Equatable,Sendable {
    let width:Int;let height:Int;let bitRate:Double
    var id:String{"r:\(width)x\(height)"}
    var label:String{"\(width) × \(height)"}
    var size:CGSize{CGSize(width:width,height:height)}
}
@MainActor @Observable final class PhonePlaybackModel {
    let player=AVPlayer()
    let captions=NativeCaptionsModel()
    let progress=RemoteProgressRecorder()
    private(set) var qualityChoices:[PhoneQualityChoice]=[]
    private(set) var qualityPreference=UserDefaults.standard.string(forKey:"flyx.phone.qualityPreference") ?? "highest"
    private(set) var qualityEnabled=false
    var effectiveQualityID:String{qualityPreference=="automatic" ? "automatic":(qualityChoices.contains{$0.id==qualityPreference} ? qualityPreference:"highest")}
    var qualitySelectionLabel:String{effectiveQualityID=="automatic" ? "Automatic":(qualityChoices.first{$0.id==effectiveQualityID}?.label ?? "Highest available")}
    var qualitySummary:String{
        if effectiveQualityID=="automatic"{return "Automatic quality"}
        if let selected=qualityChoices.first(where:{$0.id==effectiveQualityID}){return "Prefer up to \(selected.label)"}
        return qualityChoices.first.map{"Highest available · up to \($0.label)"} ?? "Highest available preference"
    }
    var qualityNote:String?{qualityPreference != "highest" && qualityPreference != "automatic" && effectiveQualityID=="highest" ? "Saved resolution unavailable in this source; using highest available.":nil}
    func selectQuality(_ id:String){
        guard qualityEnabled,id=="highest" || id=="automatic" || qualityChoices.contains(where:{$0.id==id}) else{return}
        qualityPreference=id;UserDefaults.standard.set(id,forKey:"flyx.phone.qualityPreference");if let item=player.currentItem{applyQuality(to:item)}
    }
    private func applyQuality(to item:AVPlayerItem){
        guard qualityEnabled else{return}
        let choice=effectiveQualityID=="highest" ? qualityChoices.first:qualityChoices.first{$0.id==effectiveQualityID}
        item.preferredMaximumResolution=choice?.size ?? .zero
        item.preferredPeakBitRate=effectiveQualityID=="highest" ? 0:choice.map{$0.bitRate>0 ? $0.bitRate*1.05:0} ?? 0
    }
    private func inspectQuality(_ variants:[AVAssetVariant]){
        var choices:[String:PhoneQualityChoice]=[:]
        for variant in variants{
            guard let size=variant.videoAttributes?.presentationSize,size.width.isFinite,size.height.isFinite,size.width>0,size.height>0,size.width<=16384,size.height<=16384 else{continue}
            let peak=variant.peakBitRate ?? 0
            let bitrate=peak.isFinite ? max(0,peak):0
            let choice=PhoneQualityChoice(width:Int(size.width.rounded()),height:Int(size.height.rounded()),bitRate:bitrate)
            if (choices[choice.id]?.bitRate ?? -1)<choice.bitRate{choices[choice.id]=choice}
        }
        qualityChoices=choices.values.sorted{a,b in a.width*a.height==b.width*b.height ? a.bitRate>b.bitRate:a.width*a.height>b.width*b.height}
    }
    private var requestedStart:Double?
    private var observedPosition:Double?
    private var observedAt=Date.distantPast
    private var continuousPlayed=0.0
    @ObservationIgnored private var endedObservation:NSObjectProtocol?
    private var backgrounded=false
    private var foregroundSnapshot:(position:Double,paused:Bool)?
    private var deferredPlaybackFailure=false
    var hasForegroundInterruption:Bool{foregroundSnapshot != nil && !backgrounded}
    var title="This iPhone"
    var busy=false
    var error:String?
    var ready=false
    var suppressLocalProgress=false
    var sources:[PhoneSource]{grant?.sources ?? []}
    var currentSource:String?{grant?.currentSource}
    var sourceInfo:PlaybackSourceInfo?{grant?.sourceInfo}
    private var selection:PhonePlaybackSelection?
    @ObservationIgnored private var playbackTask:Task<Void,Never>?
    private var lastGoodPosition=0.0
    private var intendedPaused=false
    @ObservationIgnored private var timeObserver:Any?
    private var loadFailure:String?
    private var grant:PhoneMediaGrant?
    private var grantClient:RemoteClient?
    private var loader:PairedMediaLoader?
    private var hls:LoopbackHLS?
    private var generation=UUID()
    private var closed=false
    @ObservationIgnored private var failedEndObservation:NSObjectProtocol?
    @ObservationIgnored private var itemObservation:NSKeyValueObservation?
    func prepare(_ client:RemoteClient,selection:PhonePlaybackSelection?=nil,position:Double?=nil)async {
        if suppressLocalProgress{ready=false;suppressLocalProgress=false}
        // A new selection must never recover or send chunks from the previous title's lease.
        playbackTask?.cancel();playbackTask=nil;recordProgress(client,force:true);retire(client,restore:false)
        foregroundSnapshot=nil;deferredPlaybackFailure=false;lastGoodPosition=0;intendedPaused=false
        captions.resetPreference();self.selection=selection;requestedStart=position;closed=false
        if timeObserver==nil{timeObserver=player.addPeriodicTimeObserver(forInterval:CMTime(seconds:0.5,preferredTimescale:600),queue:.main){[weak self] time in let seconds=time.seconds;Task{@MainActor in guard let self,self.ready,seconds.isFinite,seconds>=0 else{return};self.lastGoodPosition=seconds;if !self.backgrounded,self.player.timeControlStatus == .playing{self.intendedPaused=false}else if !self.backgrounded,self.player.timeControlStatus == .paused,self.player.currentItem?.status == .readyToPlay,self.player.currentItem?.error==nil{self.intendedPaused=true}}}}
        await run(client,operation:"prepare")
    }
    func choose(_ client:RemoteClient,sourceID:String)async{guard !busy,!closed,sourceID != currentSource else{return};await run(client,operation:"select-source",sourceID:sourceID)}
    private func recover(_ client:RemoteClient,message:String){
        guard !closed else{return}
        if backgrounded{deferredPlaybackFailure=true;return}
        if busy{loadFailure=message;return}
        guard selection != nil,grant != nil else{stop(client);error=message;return}
        busy=true;playbackTask=Task{await run(client,operation:"next-source")}
    }
    private func clearPlayer(){qualityChoices=[];qualityEnabled=false;if let endedObservation{NotificationCenter.default.removeObserver(endedObservation);self.endedObservation=nil};continuousPlayed=0;observedPosition=nil;if let failedEndObservation{NotificationCenter.default.removeObserver(failedEndObservation);self.failedEndObservation=nil};itemObservation?.invalidate();itemObservation=nil;player.pause();player.replaceCurrentItem(with:nil);captions.attach(nil);loader?.cancelAll();loader=nil;hls?.stop();hls=nil}
    private func run(_ client:RemoteClient,operation:String,sourceID:String?=nil)async {
        let ticket=UUID();generation=ticket;error=nil
        let requestedSelection=selection,requestedPosition=requestedStart
        var position=operation=="next-source" ? lastGoodPosition:player.currentTime().seconds;var paused=operation=="next-source" ? intendedPaused:(ready ? player.rate==0:(grant?.paused ?? false))
        if !position.isFinite||position<0{position=grant?.position ?? 0}
        if let duration=player.currentItem?.duration.seconds,duration.isFinite,duration>0{position=min(position,max(0,duration-0.05))}
        recordProgress(client,force:true);let saving=progress.task
        ready=false;busy=true;clearPlayer();defer{if generation==ticket{busy=false}}
        await saving?.value
        guard !closed,generation==ticket,!Task.isCancelled else{return}
        var nextOperation=operation;var attempts=0;var playbackFailure:String?
        while !closed,generation==ticket,!Task.isCancelled {
        attempts+=1;loadFailure=nil;var resolved=false
        do {
            let value:PhoneMediaGrant=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:nextOperation,handle:nextOperation=="prepare" ? nil:grant?.handle,position:nextOperation=="prepare" ? requestedPosition:position,paused:paused,selection:nextOperation=="prepare" ? requestedSelection:nil,sourceID:sourceID)))
            if closed||generation != ticket||Task.isCancelled{let _:RemoteOK?=try? await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"cancel-prepare",handle:value.handle)));return}
            if let requestedSelection,let returned=value.sourceInfo?.selection,requestedSelection.id != returned.id{
                let _:RemoteOK?=try? await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"close",handle:value.handle)))
                throw RemoteFailure(message:"The source returned a different title or episode. Playback was not started.")
            }
            grant=value;grantClient=client;title=value.title;resolved=true
            if nextOperation=="prepare"{position=value.position;paused=value.paused;lastGoodPosition=position;intendedPaused=paused}
            guard ["mp4","hls"].contains(value.format) else{throw RemoteFailure(message:"This source cannot play natively on this iPhone.")}
            try Task.checkCancellation();guard !closed,generation==ticket else{return}
            let asset:AVURLAsset
            if value.format=="hls"{let proxy=try LoopbackHLS(client:client,handle:value.handle,failure:{[weak self] message in Task{@MainActor in guard let self,self.generation==ticket,!self.closed else{return};self.recover(client,message:message)}});hls=proxy;let url=try await proxy.start()
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("details-hls")}){var denied=URLRequest(url:url);denied.timeoutInterval=3;let config=URLSessionConfiguration.ephemeral;config.httpCookieStorage=nil;let socket=URLSession(configuration:config);_ = try? await socket.data(for:denied);socket.invalidateAndCancel()}
                #endif
                asset=AVURLAsset(url:url,options:[AVURLAssetHTTPCookiesKey:proxy.cookies])}
            else{let loader=PairedMediaLoader(client:client,handle:value.handle);self.loader=loader;asset=AVURLAsset(url:loader.assetURL);asset.resourceLoader.setDelegate(loader,queue:loader.queue)}
            guard try await asset.load(.isPlayable) else{throw RemoteFailure(message:"This source uses a codec this iPhone cannot play. Keep playback on the Mac.")}
            try Task.checkCancellation();guard !closed,generation==ticket else{return}
            if client.isStandalone{
                let variants=(try? await asset.load(.variants)) ?? []
                try Task.checkCancellation();guard !closed,generation==ticket else{return}
                qualityEnabled=true;inspectQuality(variants)
            }
            let item=AVPlayerItem(asset:asset);applyQuality(to:item)
            observeFailures(client,item:item,ticket:ticket)
            player.replaceCurrentItem(with:item);captions.attach(item);observeEnd(client,item:item,ticket:ticket)
            guard await player.seek(to:CMTime(seconds:value.position,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) else{throw RemoteFailure(message:"The iPhone could not restore this position.")}
            try Task.checkCancellation();guard !closed,generation==ticket else{return}
            let ack:CommandResult=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"phone-ready",handle:value.handle,position:value.position,paused:value.paused)))
            guard ack.ok,value.mode=="direct" || ack.status.state=="paused" else{throw RemoteFailure(message:"The Mac did not confirm pausing. Playback remains paused on this iPhone.")}
            try Task.checkCancellation();guard !closed,generation==ticket else{return}
            guard let transfer=ack.transfer,transfer.position.isFinite,transfer.position>=0 else{throw RemoteFailure(message:"Update Flyx on the Mac to transfer the latest playback position safely.")}
            guard await player.seek(to:CMTime(seconds:transfer.position,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) else{throw RemoteFailure(message:"The iPhone could not restore the latest Mac position.")}
            try Task.checkCancellation();guard !closed,generation==ticket else{return}
            let _:RemoteOK=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"phone-started",handle:value.handle,position:player.currentTime().seconds,paused:transfer.paused)))
            try Task.checkCancellation();guard !closed,generation==ticket else{return}
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("details-hls")}){UIOnlyProtocol.probe(["hlsNativeReady":true,"hlsCredentialAbsentFromSharedCookies":HTTPCookieStorage.shared.cookies?.contains(where:{$0.name=="flyxLocal"}) != true])}
            #endif
            if let loadFailure{throw RemoteFailure(message:loadFailure)}
            lastGoodPosition=player.currentTime().seconds;intendedPaused=transfer.paused;ready=true;if !backgrounded{foregroundSnapshot=nil};recordProgress(client,force:true);if !transfer.paused,!backgrounded{player.play()}
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("details-source")}){UIOnlyProtocol.probe(["sourceNativeReady":true,"sourceNativeCurrent":value.currentSource ?? "none","sourceNativePosition":player.currentTime().seconds])}
            if ProcessInfo.processInfo.arguments.contains("details-source-playback"),value.currentSource=="0"{UIOnlyProtocol.probe(["syntheticPlaybackFailureNotification":true]);NotificationCenter.default.post(name:AVPlayerItem.failedToPlayToEndTimeNotification,object:item)}
            #endif
            return
        }catch is CancellationError {if generation==ticket{if backgrounded{deferredPlaybackFailure=true}else{stop(client)}};return}catch{
            #if DEBUG
            if (ProcessInfo.processInfo.arguments.contains("--standalone-player53") || ProcessInfo.processInfo.arguments.contains("--standalone-movie54")),resolved{let e=error as NSError;UIOnlyProtocol.probe(["standaloneFailureOperation":nextOperation,"standaloneFailureDomain":e.domain,"standaloneFailureCode":e.code,"standaloneUnderlyingDomain":(e.userInfo[NSUnderlyingErrorKey] as? NSError)?.domain ?? "","standaloneUnderlyingCode":(e.userInfo[NSUnderlyingErrorKey] as? NSError)?.code ?? 0,"standaloneFailureMessage":(error as? RemoteFailure)?.message ?? "Native asset failed"])}
            #endif
            guard generation==ticket,!closed else{return};if backgrounded{deferredPlaybackFailure=true;return};clearPlayer()
            if selection != nil,grant != nil,resolved,attempts<5{playbackFailure=error.localizedDescription;nextOperation="next-source";continue}
            self.error=playbackFailure ?? error.localizedDescription
            if client.isStandalone{retire(client,restore:false)}else if selection == nil{retire(client,restore:true)}
            return
        }
        }
    }
    private func observeFailures(_ client:RemoteClient,item:AVPlayerItem,ticket:UUID){
            itemObservation=item.observe(\.status,options:[.new]){[weak self] item,_ in guard item.status == .failed else{return};
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--standalone-movie54"){captureMoviePlayerDiagnostics(item,phase:"item-failed")}
                if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("details-hls")}){let failure=item.error as NSError?;UIOnlyProtocol.probe(["hlsFailureDomain":failure?.domain ?? "unknown","hlsFailureCode":failure?.code ?? 0,"hlsFailureReason":failure?.localizedFailureReason ?? "unknown"])}
                #endif
                Task{@MainActor in guard let self,self.generation==ticket,!self.closed else{return};self.recover(client,message:"The stream stopped. Trying another source…")}}
            failedEndObservation=NotificationCenter.default.addObserver(forName:AVPlayerItem.failedToPlayToEndTimeNotification,object:item,queue:.main){[weak self] _ in
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--standalone-movie54"){captureMoviePlayerDiagnostics(item,phase:"failed-to-end")}
                #endif
                Task{@MainActor in guard let self,self.generation==ticket,!self.closed else{return};self.recover(client,message:"The source failed during playback. Trying another source…")}}
    }
    func notePaused(_ value:Bool){intendedPaused=value}
    func applicationDidBackground(_ client:RemoteClient){
        guard !backgrounded,!closed else{return}
        let value=player.currentTime().seconds
        let position=value.isFinite && value>=0 ? value:lastGoodPosition
        let paused=player.timeControlStatus == .playing || player.rate>0 ? false:intendedPaused
        foregroundSnapshot=(max(position,lastGoodPosition),paused);backgrounded=true
        recordProgress(client,force:true);player.pause()
    }
    func applicationDidBecomeActive(_ client:RemoteClient)async{
        guard backgrounded || foregroundSnapshot != nil else{return};backgrounded=false
        guard let snapshot=foregroundSnapshot,!closed else{return}
        let ticket=generation
        if let hls,!(await hls.isUsable()){deferredPlaybackFailure=true}
        guard ticket==generation,!backgrounded,!closed,!Task.isCancelled else{return}
        if ready,player.currentItem?.status == .readyToPlay,player.currentItem?.error==nil,!deferredPlaybackFailure{
            foregroundSnapshot=nil;if !snapshot.paused{player.play()};return
        }
        await retryForegroundPlayback(client)
    }
    func retryForegroundPlayback(_ client:RemoteClient)async{
        guard let snapshot=foregroundSnapshot,!backgrounded,!closed,!busy else{return}
        guard let value=grant else{error="Phone preparation was interrupted. Reopen this title and choose Play on This iPhone.";return}
        let raw=player.currentTime().seconds
        let position=max(snapshot.position,raw.isFinite ? max(0,raw):0,lastGoodPosition)
        let ticket=UUID();generation=ticket;busy=true;ready=false;error=nil;deferredPlaybackFailure=false;loadFailure=nil;clearPlayer()
        defer{if generation==ticket{busy=false}}
        do{
            let asset:AVURLAsset
            if value.format=="hls"{
                let proxy=try LoopbackHLS(client:client,handle:value.handle,failure:{[weak self] _ in Task{@MainActor in guard let self,self.generation==ticket else{return};self.deferredPlaybackFailure=true}})
                hls=proxy;asset=AVURLAsset(url:try await proxy.start(),options:[AVURLAssetHTTPCookiesKey:proxy.cookies])
            }else{let loader=PairedMediaLoader(client:client,handle:value.handle);self.loader=loader;asset=AVURLAsset(url:loader.assetURL);asset.resourceLoader.setDelegate(loader,queue:loader.queue)}
            guard try await asset.load(.isPlayable) else{throw RemoteFailure(message:"The current phone source cannot be restored.")}
            try Task.checkCancellation();guard generation==ticket,!backgrounded,!closed else{return}
            if client.isStandalone{qualityEnabled=true;inspectQuality((try? await asset.load(.variants)) ?? [])}
            let item=AVPlayerItem(asset:asset);applyQuality(to:item);observeFailures(client,item:item,ticket:ticket);player.replaceCurrentItem(with:item);captions.attach(item);observeEnd(client,item:item,ticket:ticket)
            guard await player.seek(to:CMTime(seconds:position,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) else{throw RemoteFailure(message:"The iPhone could not restore its playback position.")}
            try Task.checkCancellation();guard generation==ticket,!backgrounded,!closed else{return}
            guard loadFailure==nil,!deferredPlaybackFailure else{throw RemoteFailure(message:"The current phone source did not resume.")}
            ready=true;lastGoodPosition=position;intendedPaused=snapshot.paused;deferredPlaybackFailure=false;foregroundSnapshot=nil
            if !snapshot.paused{player.play()};recordProgress(client,force:true)
        }catch{if generation==ticket,!backgrounded,!Task.isCancelled{self.error="Phone playback was interrupted. Retry this iPhone to restore the same position."}}
    }
    private func retire(_ client:RemoteClient,restore:Bool){
        guard let handle=grant?.handle else{return};let owner=grantClient ?? client;grant=nil;grantClient=nil
        // Cleanup must outlive the cancelled SwiftUI task; only immutable,
        // Sendable client/handle values cross into this detached task.
        let progressTask=progress.task
        Task.detached(priority:.utility){await progressTask?.value;let _:RemoteOK?=try? await owner.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:restore ? "cancel-prepare":"close",handle:handle)))}
    }
    func stop(_ client:RemoteClient){foregroundSnapshot=nil;backgrounded=false;deferredPlaybackFailure=false;recordProgress(client,force:true);if let endedObservation{NotificationCenter.default.removeObserver(endedObservation);self.endedObservation=nil};if let timeObserver{player.removeTimeObserver(timeObserver);self.timeObserver=nil};if let failedEndObservation{NotificationCenter.default.removeObserver(failedEndObservation);self.failedEndObservation=nil};playbackTask?.cancel();playbackTask=nil;itemObservation?.invalidate();itemObservation=nil;let wasReady=ready;closed=true;generation=UUID();ready=false;busy=false;player.pause();player.replaceCurrentItem(with:nil);captions.attach(nil);loader?.cancelAll();loader=nil;hls?.stop();hls=nil;retire(client,restore:!wasReady)}
    private func observeEnd(_ client:RemoteClient,item:AVPlayerItem,ticket:UUID){if let endedObservation{NotificationCenter.default.removeObserver(endedObservation)};endedObservation=NotificationCenter.default.addObserver(forName:AVPlayerItem.didPlayToEndTimeNotification,object:item,queue:.main){[weak self]_ in Task{@MainActor in guard let self,self.generation==ticket,self.ready,self.player.currentItem?.error==nil else{return};let duration=self.player.currentItem?.duration.seconds ?? 0;guard duration.isFinite,duration>0,self.continuousPlayed+0.75>=min(5,duration) else{return};self.recordProgress(client,force:true,ended:true)}}}
    func recordProgress(_ client:RemoteClient,force:Bool=false,ended:Bool=false){guard !suppressLocalProgress,ready,let handle=grant?.handle else{return};let position=player.currentTime().seconds;let now=Date();if position.isFinite,player.rate>0{if let previous=observedPosition{let delta=position-previous,elapsed=now.timeIntervalSince(observedAt);if delta>=0,delta<=elapsed+1{continuousPlayed+=delta}else{continuousPlayed=0}}};observedPosition=position;observedAt=now;progress.record(grantClient ?? client,handle:handle,position:position,duration:player.currentItem?.duration.seconds ?? 0,ended:ended,force:force)}
    func recordCastProgress(_ client:RemoteClient,position:Double,duration:Double){guard suppressLocalProgress,let handle=grant?.handle else{return};progress.record(grantClient ?? client,handle:handle,position:position,duration:duration)}
    func flushProgress(_ client:RemoteClient)async{recordProgress(client,force:true);await progress.task?.value}
    struct TransferSnapshot {let handle:String;let position:Double;let paused:Bool}
    func transferSnapshot(paused:Bool?=nil)throws->TransferSnapshot {
        guard let grant,ready,!closed else{throw RemoteFailure(message:"This iPhone has no ready playback session.")}
        let position=player.currentTime().seconds
        guard position.isFinite,position>=0 else{throw RemoteFailure(message:"The iPhone playback position is unavailable.")}
        return .init(handle:grant.handle,position:position,paused:paused ?? (player.rate==0))
    }
    func stageTransfer(_ client:RemoteClient,data:DestinationTransferData,title:String)async throws {
        guard !ready else{throw RemoteFailure(message:"This iPhone already owns playback.")}
        closed=false;clearPlayer();busy=true;error=nil
        let ticket=UUID();generation=ticket
        defer{if generation==ticket{busy=false}}
        grant=PhoneMediaGrant(handle:data.handle,title:title,position:data.position,duration:data.duration,paused:true,format:data.format,mode:"transfer",sourceInfo:data.sourceInfo)
        self.title=title
        let asset:AVURLAsset
        if data.format=="hls" {
            let proxy=try LoopbackHLS(client:client,handle:data.handle,failure:{[weak self] message in Task{@MainActor in guard let self,self.generation==ticket else{return};self.loadFailure=message}})
            hls=proxy;asset=AVURLAsset(url:try await proxy.start(),options:[AVURLAssetHTTPCookiesKey:proxy.cookies])
        } else if data.format=="mp4" {
            let loader=PairedMediaLoader(client:client,handle:data.handle);self.loader=loader
            asset=AVURLAsset(url:loader.assetURL);asset.resourceLoader.setDelegate(loader,queue:loader.queue)
        } else{throw RemoteFailure(message:"This source cannot play natively on this iPhone.")}
        guard try await asset.load(.isPlayable) else{throw RemoteFailure(message:"This iPhone cannot decode the selected source.")}
        try Task.checkCancellation();guard generation==ticket,!closed else{throw CancellationError()}
        let item=AVPlayerItem(asset:asset);player.replaceCurrentItem(with:item);captions.attach(item);observeEnd(client,item:item,ticket:ticket);player.pause()
        let deadline=ContinuousClock.now.advanced(by:.seconds(15))
        while player.currentItem?.status != .readyToPlay {
            try Task.checkCancellation();guard generation==ticket,!closed else{throw CancellationError()}
            guard player.currentItem?.status != .failed,ContinuousClock.now<deadline else{throw RemoteFailure(message:"The iPhone player did not become ready. The original output is unchanged.")}
            try await Task.sleep(for:.milliseconds(50))
        }
        try await seekTransfer(to:data.position)
    }
    func seekTransfer(to position:Double)async throws {
        guard position.isFinite,position>=0,await player.seek(to:CMTime(seconds:position,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero),abs(player.currentTime().seconds-position)<=1 else{throw RemoteFailure(message:"The iPhone could not confirm the transferred playback position.")}
        try Task.checkCancellation()
    }
    func finishTransfer(paused:Bool) {ready=true;busy=false;intendedPaused=paused;lastGoodPosition=player.currentTime().seconds;if paused || backgrounded{player.pause()}else{player.play()}}
    func returnToMac(_ client:RemoteClient)async->Bool {
        guard let grant,ready,!busy,!closed else{return false}
        await flushProgress(client)
        let ticket=generation
        let paused=player.rate==0
        var position=player.currentTime().seconds
        if let duration=player.currentItem?.duration.seconds,duration.isFinite,duration>0{position=min(position,max(0,duration-0.05))}
        busy=true;defer{busy=false}
        do {
            guard position.isFinite,position>=0 else{throw RemoteFailure(message:"Current playback position is unavailable.")}
            let ack:CommandResult=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"mac",handle:grant.handle,position:position,paused:paused)))
            guard !closed,generation==ticket,!Task.isCancelled else{return false}
            guard ack.ok,abs(ack.status.position-position)<2,ack.status.state==(paused ? "paused":"playing") else{throw RemoteFailure(message:"The Mac did not confirm the requested position and playback state. iPhone playback continues.")}
            player.pause();return true
        }catch{self.error=error.localizedDescription;return false}
    }
}
struct PhonePlaybackView:View {
    let client:RemoteClient
    var selection:PhonePlaybackSelection?=nil
    var body:some View{RemoteControlView(client:client,initialSelection:selection,startsOnPhone:true,showClose:true)}
}

#if DEBUG
/// Read-only event snapshots; resource URLs, session identifiers and credentials are omitted.
private func captureMoviePlayerDiagnostics(_ item:AVPlayerItem,phase:String){
    func clean(_ value:String?)->String{String((value ?? "").replacingOccurrences(of:"https?://[^\\s\"<>]+",with:"[resource]",options:.regularExpression).prefix(300))}
    let failure=item.error as NSError?,underlying=failure?.userInfo[NSUnderlyingErrorKey] as? NSError
    let errors=(item.errorLog()?.events ?? []).suffix(8).map{["code":$0.errorStatusCode,"domain":$0.errorDomain,"comment":clean($0.errorComment),"host":URL(string:$0.uri ?? "")?.host ?? ""] as [String:Any]}
    let access=(item.accessLog()?.events ?? []).suffix(4).map{["requests":$0.numberOfMediaRequests,"bytes":$0.numberOfBytesTransferred,"stalls":$0.numberOfStalls,"bitrate":$0.observedBitrate.isFinite ? $0.observedBitrate:0] as [String:Any]}
    UIOnlyProtocol.probe(["movieNativeFailure":["phase":phase,"domain":failure?.domain ?? "","code":failure?.code ?? 0,"reason":clean(failure?.localizedFailureReason),"underlyingDomain":underlying?.domain ?? "","underlyingCode":underlying?.code ?? 0,"errorEvents":errors,"accessEvents":access]])
}
#endif
