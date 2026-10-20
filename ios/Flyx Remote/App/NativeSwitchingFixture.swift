#if DEBUG
import SwiftUI
@preconcurrency import AVKit
@preconcurrency import GoogleCast
@MainActor struct NativeSwitchingFixture:View {
 let client:RemoteClient
 @State private var session=PlaybackSession()
 @State private var presented=false
 @State private var result="Running native controller integration…"
 var body:some View{VStack(spacing:24){Text(result);Button("Open shared controls"){presented=true};Button("Prepare slow handoff test"){Task{try? await mode("slow");presented=true}}}.padding().environment(\.playbackSession,session).fullScreenCover(isPresented:$presented){RemoteControlView(client:client,showClose:true).environment(\.playbackSession,session)}.task{await run()}}
 private func mode(_ value:String)async throws{struct Mode:Encodable{let mode:String};let _:RemoteOK=try await client.request("/remote/v1/fixture-mode",body:JSONEncoder().encode(Mode(mode:value)))}
 private func require(_ condition:Bool,_ message:String)throws{if !condition{throw RemoteFailure(message:message)}}
 private func run()async{do{
  session.transferV2=true;session.status=try await client.request("/remote/v1/status")
  for _ in 0..<4 {
   try await session.switchOutput(client,to:"phone");try require(session.phoneActive && session.phone.ready,"Phone ownership missing")
   session.phone.player.pause();try await session.phone.seekTransfer(to:33.25)
   try await session.switchOutput(client,to:"mac");try require(!session.phoneActive && !session.phone.ready && abs((session.status?.position ?? -1)-33.25)<0.05,"Mac ownership/position missing")
  };UIOnlyProtocol.probe(["switch40RepeatedRoundTrips":4])
  try await mode("lost-confirm");try await session.switchOutput(client,to:"phone");try require(session.phoneActive && session.phone.ready,"Lost confirmation did not reconcile authoritative owner");UIOnlyProtocol.probe(["switch40LostConfirmReconciled":true]);try await session.switchOutput(client,to:"mac")
  try await mode("failed-phone");do{try await session.switchOutput(client,to:"phone");throw RemoteFailure(message:"Failed phone source unexpectedly succeeded")}catch{try require(!session.phoneActive && !session.phone.ready,"Failed phone source changed owner")};UIOnlyProtocol.probe(["switch40FailedPhonePreservedOrigin":true])
  try await mode("normal");try await session.switchOutput(client,to:"phone")
  let native=session.phone.player
  try await mode("failed-mac");do{try await session.switchOutput(client,to:"mac");throw RemoteFailure(message:"Failed Mac source unexpectedly succeeded")}catch{try require(session.phoneActive && session.phone.ready && session.phone.player===native,"Failed Mac source retired native phone")};UIOnlyProtocol.probe(["switch40FailedMacPreservedOrigin":true])
  try await mode("slow-mac");session.run{try await session.switchOutput(client,to:"mac")};session.run{throw RemoteFailure(message:"Duplicate task admitted")};try await Task.sleep(for:.milliseconds(100));session.cancel(client)
  let deadline=ContinuousClock.now.advanced(by:.seconds(10));while session.busy{try require(ContinuousClock.now<deadline,"Cancellation did not settle");try await Task.sleep(for:.milliseconds(50))}
  try require(session.phoneActive && session.phone.ready && session.phone.player===native && session.error==nil,"Cancellation/repeat changed origin or created duplicate owner");UIOnlyProtocol.probe(["switch40CancelRollbackConfirmed":true,"switch40DuplicateWorkRejected":true])
  try await mode("normal");try await session.switchOutput(client,to:"mac");result="Native controller tests passed. Open shared controls for Done/reopen/rotation QA.";UIOnlyProtocol.probe(["switch40NativeIntegrationPassed":true,"switch40NativeIntegrationError":"none"])
 }catch{result=error.localizedDescription;UIOnlyProtocol.probe(["switch40NativeIntegrationPassed":false,"switch40NativeIntegrationError":error.localizedDescription])}}
}
#endif

#if DEBUG
private final class DestinationFixtureState69:@unchecked Sendable{
    let lock=NSLock();var mode="normal";var commands=0;var prepares=0;var phoneStarts=0;var hlsIDs=Set<String>();var audioOutputs:[String]=[];var destinations:[String:String]=[:];var cancelled=Set<String>()
    func setMode(_ value:String){lock.withLock{mode=value}}
}
private final class DestinationFixtureProtocol69:URLProtocol,@unchecked Sendable{
    static let state=DestinationFixtureState69()
    private let lock=NSLock();private var stopped=false
    private var network:URLSessionDataTask?
    private var forwardingSession:URLSession?
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    private func payload()->[String:Any]{
        var data=request.httpBody ?? Data()
        if data.isEmpty,let stream=request.httpBodyStream{stream.open();defer{stream.close()};var bytes=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable,data.count<65536{let n=stream.read(&bytes,maxLength:bytes.count);if n<=0{break};data.append(contentsOf:bytes.prefix(n))}}
        return (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:]
    }
    private func reply(_ body:[String:Any],status:Int=200){
        guard !lock.withLock({stopped}) else{return}
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:try! JSONSerialization.data(withJSONObject:body));client?.urlProtocolDidFinishLoading(self)
    }
    override func startLoading(){
        let body=payload(),path=request.url!.path,mode=Self.state.lock.withLock{Self.state.mode}
        let operation=body["operation"] as? String ?? ""
        if path=="/remote/v1/info"{DispatchQueue.global().asyncAfter(deadline:.now()+1){[self] in reply(["features":["player.transfer.confirm.v2"]])};return}
        if path=="/remote/v1/status"{
            if mode=="status-offline"{reply(["code":"SYNTHETIC_OFFLINE"],status:503);return}
            let value:[String:Any]=mode=="status-idle" ? ["state":"idle","position":0,"duration":0,"output":"mac"]:mode=="status-tv" ? ["state":"paused","position":88,"duration":100,"title":"Actual inert TV","output":"tv","outputName":"Inert TV"]:["state":"playing","position":80,"duration":100,"title":"Stale Mac reply","output":"mac"]
            DispatchQueue.global().asyncAfter(deadline:.now()+(mode=="status-slow" ? 0.9:0.15)){[self] in reply(value)};return
        }
        if path=="/remote/v1/commands",ProcessInfo.processInfo.arguments.contains("captions-controls71"),["volume","mute"].contains(body["type"] as? String ?? ""){Self.state.lock.withLock{Self.state.audioOutputs.append(body["output"] as? String ?? "missing")};forward(body);return}
        if path=="/remote/v1/commands"{Self.state.lock.withLock{Self.state.commands+=1};reply(["ok":true,"status":["state":"paused","position":0.75,"duration":2,"title":"Inert Mac","output":"mac"]]);return}
        if path=="/remote/v1/transfers"{
            let id=body["id"] as? String ?? "",destination=body["destination"] as? String ?? Self.state.lock.withLock{Self.state.destinations[id] ?? "phone"}
            if operation=="prepare"{Self.state.lock.withLock{Self.state.destinations[id]=destination}}
            if operation=="cancel"{_ = Self.state.lock.withLock{Self.state.cancelled.insert(id)};reply(["id":id,"phase":"cancelled","rollbackConfirmed":true]);return}
            if operation=="status",Self.state.lock.withLock({Self.state.cancelled.contains(id)}){reply(["id":id,"phase":"cancelled","rollbackConfirmed":true]);return}
            if operation=="prepare",mode=="fail-transfer"{reply(["code":"SYNTHETIC_FAILURE"],status:503);return}
            let output:[String:Any]=["identity":"synthetic:69","position":0.75,"paused":true,"output":destination]
            var response:[String:Any]=["id":id,"phase":operation=="prepare" ? "prepared":operation=="commit" && destination=="phone" ? "awaiting-native-confirm":"committed","status":output]
            if operation=="prepare",destination=="phone"{response["destinationData"]=["handle":"synthetic-mp4-only","format":"mp4","position":0.75,"duration":2,"paused":true]}
            if mode=="slow-transfer",operation=="prepare"{let captured=response;DispatchQueue.global().asyncAfter(deadline:.now()+0.8){[self] in reply(captured)}}else{reply(response)}
            return
        }
        if path=="/remote/v1/media"{Self.state.lock.withLock{if operation=="prepare"{Self.state.prepares+=1};if operation=="phone-started"{Self.state.phoneStarts+=1}}}
        if path=="/remote/v1/media",request.url?.host=="captions-hls71.local"{
            if operation=="prepare"{reply(["handle":"synthetic-captions71","title":"Generated subtitle HLS","position":1,"duration":30,"paused":true,"format":"hls","mode":"direct"]);return}
            if operation=="resource"{do{
                let id=Int(body["resourceID"] as? String ?? "0") ?? 0
                let names=["master.m3u8","video.m3u8","subtitles.m3u8","subtitles.vtt"]+(0..<15).map{"part\($0).ts"}
                guard names.indices.contains(id) else{throw URLError(.badURL)}
                var data=try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("fullscreen70-HLS/"+names[id]))
                if names[id].hasSuffix("m3u8"){var text=String(decoding:data,as:UTF8.self);for (n,name) in names.enumerated().reversed(){text=text.replacingOccurrences(of:name,with:"flyx-resource://\(n)")};data=Data(text.utf8)}
                reply(["bytes":data.base64EncodedString(),"contentType":names[id].hasSuffix("m3u8") ? "application/vnd.apple.mpegurl":names[id].hasSuffix("vtt") ? "text/vtt":"video/mp2t","status":200])
            }catch{reply(["code":"SYNTHETIC_MISSING_CAPTIONS"],status:500)};return}
        }
        if path=="/remote/v1/media",request.url?.host=="fullscreen-hls70.local"{
            if operation=="prepare"{reply(["handle":"synthetic-hls70","title":"Generated silent HLS","position":1,"duration":30,"paused":true,"format":"hls","mode":"direct"]);return}
            if operation=="resource"{do{
                let id=Int(body["resourceID"] as? String ?? "0") ?? 0;_ = Self.state.lock.withLock{Self.state.hlsIDs.insert(String(id))};let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("fullscreen70-HLS")
                var data=try Data(contentsOf:folder.appendingPathComponent(id==0 ? "master.m3u8":"part\(id-1).ts"))
                if id==0{var text=String(decoding:data,as:UTF8.self);for n in (0..<30).reversed(){text=text.replacingOccurrences(of:"part\(n).ts",with:"flyx-resource://\(n+1)")};data=Data(text.utf8)}
                reply(["bytes":data.base64EncodedString(),"contentType":id==0 ? "application/vnd.apple.mpegurl":"video/mp2t","status":200])
            }catch{reply(["code":"SYNTHETIC_MISSING_HLS"],status:500)};return}
        }

        if path=="/remote/v1/media",operation=="chunk",ProcessInfo.processInfo.arguments.contains(where:{["fullscreen-lifecycle70","captions-controls71","captions-portrait71","captions-fullscreen71"].contains($0)}){
            do{let bytes=try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("fullscreen70.mp4"));let offset=body["offset"] as? Int ?? 0,length=body["length"] as? Int ?? 2;guard offset>=0,offset<bytes.count else{throw URLError(.badServerResponse)};reply(["bytes":bytes.subdata(in:offset..<min(bytes.count,offset+length)).base64EncodedString(),"offset":offset,"total":bytes.count])}catch{reply(["code":"SYNTHETIC_MISSING_ASSET"],status:500)};return
        }
        if path=="/remote/v1/media",operation=="prepare",mode=="fail-media"{reply(["code":"SYNTHETIC_FAILURE"],status:503);return}
        if path=="/remote/v1/media",operation=="prepare",["slow-media","hold-media"].contains(mode){DispatchQueue.global().asyncAfter(deadline:.now()+(mode=="hold-media" ? 30:0.8)){[self] in forward(body)};return}
        forward(body)
    }
    private func forward(_ body:[String:Any]){
        guard !lock.withLock({stopped}) else{return}
        // The existing URLProtocol serves an embedded generated silent MP4. No external network is used.
        let configuration=URLSessionConfiguration.ephemeral;configuration.protocolClasses=[UIOnlyProtocol.self]
        let session=URLSession(configuration:configuration);forwardingSession=session
        var forwarded=request;if request.httpMethod=="POST"{forwarded.httpBody=try? JSONSerialization.data(withJSONObject:body)}
        network=session.dataTask(with:forwarded){[weak self] data,response,error in
            guard let self,!self.lock.withLock({self.stopped}) else{session.invalidateAndCancel();return}
            defer{session.finishTasksAndInvalidate()}
            if let error{self.client?.urlProtocol(self,didFailWithError:error);return}
            self.client?.urlProtocol(self,didReceive:response!,cacheStoragePolicy:.notAllowed);if let data{self.client?.urlProtocol(self,didLoad:data)};self.client?.urlProtocolDidFinishLoading(self)
        };network?.resume()
    }
    override func stopLoading(){lock.withLock{stopped=true};network?.cancel();forwardingSession?.invalidateAndCancel()}
}
@MainActor struct PlaybackDestinationChecks69:View{
    let mode:String
    @State private var owner=PlaybackSession()
    @State private var result="Checking playback destinations…"
    private let selection=PhonePlaybackSelection(kind:"movie",contentID:69,season:nil,episode:nil)
    private let item=RemoteTitle(id:"69",kind:"movie",title:"Synthetic phone playback",overview:"Generated silent clip only",posterURL:nil)
    private let client:RemoteClient
    init(mode:String){self.mode=mode;let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[DestinationFixtureProtocol69.self];client=RemoteClient(baseURL:URL(string:"https://destination69.local")!,session:URLSession(configuration:config))}
    var body:some View{
        Group{
            if mode=="destination-checks69"{Text(result).padding().task{await check()}}
            else if mode=="destination-tabs69"{RemoteHomeView(client:client)}
            else{RemoteControlView(client:client,initialSelection:selection,initialItem:item,startsOnPhone:true)}
        }.environment(\.playbackSession,owner).onAppear{owner.status=PlaybackStatus(state:"playing",position:80,duration:100,title:"Prior Mac playback",output:"mac");owner.phone.player.isMuted=true;owner.phone.player.volume=0;DestinationFixtureProtocol69.state.setMode(mode=="destination-loading69" ? "hold-media":"normal")}
    }
    private func settle(_ model:PlaybackSession)async throws{let deadline=ContinuousClock.now.advanced(by:.seconds(12));while model.busy{guard ContinuousClock.now<deadline else{throw RemoteFailure(message:"Fixture playback work timed out")};try await Task.sleep(for:.milliseconds(20))}}
    private func check()async{
        var checks:[String:Bool]=[:]
        do{
            let s=owner
            checks["firstFrameUsesRequestedPhone"]=s.displayedOutput(initialPhoneRequest:true)=="phone" && s.currentOutput=="mac"
            let oldEpoch=s.epoch
            let stale=Task{let value:PlaybackStatus=try await client.request("/remote/v1/status");if s.acceptsRemoteStatus(epoch:oldEpoch){s.status=value}}
            let id=UUID();s.startPhone(client,presentationID:id,selection:selection,position:nil,item:item)
            checks["phoneSelectedSynchronouslyWhileLoading"]=s.phoneActive && s.busy && s.preparingOutput=="phone" && s.displayedOutput()=="phone"
            checks["loadingRejectsStaleMacStatus"] = !s.acceptsRemoteStatus(epoch:oldEpoch)
            s.startPhone(client,presentationID:id,selection:selection,position:nil,item:item)
            try await settle(s);_ = try await stale.value
            checks["nativePhoneReady"]=s.phone.ready && s.phoneActive && s.preparingOutput==nil
            checks["lateMacReplyCannotChangePhoneDestination"]=s.displayedOutput()=="phone" && s.status?.title=="Prior Mac playback"
            let native=s.phone.player,before=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}
            let startedAt=s.phone.player.currentTime().seconds
            try await s.playbackAction(client,"resume");try await Task.sleep(for:.milliseconds(300))
            checks["nativePhonePlaybackAdvances"]=s.phone.player.currentTime().seconds>startedAt+0.1 && s.phone.player.currentItem?.status == .readyToPlay
            try await s.playbackAction(client,"pause");try await s.playbackAction(client,"seek",seconds:0.9)
            checks["phoneControlsStayLocal"]=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}==before && s.phone.player===native && abs(s.phone.player.currentTime().seconds-0.9)<0.2
            try await s.switchOutput(client,to:"mac")
            checks["acknowledgedMacSwitchChangesDestination"]=s.currentOutput=="mac" && !s.phone.ready && s.displayedOutput()=="mac"
            try await s.playbackAction(client,"pause")
            checks["MacControlsUseBackend"]=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}==before+1
            try await s.switchOutput(client,to:"phone")
            checks["switchBackUsesSamePhoneOwner"]=s.currentOutput=="phone" && s.phone.ready && s.phone.player===native
            try await s.switchOutput(client,to:"tv",receiverID:"synthetic-tv")
            checks["TVAcknowledgementSelectsTV"]=s.currentOutput=="tv" && s.displayedOutput()=="tv" && !s.phone.ready
            DestinationFixtureProtocol69.state.setMode("fail-transfer")
            do{try await s.switchOutput(client,to:"phone");checks["failedTransferKeepsOrigin"]=false}catch{checks["failedTransferKeepsOrigin"]=s.currentOutput=="tv" && s.preparingOutput==nil && !s.phone.ready}
            DestinationFixtureProtocol69.state.setMode("slow-transfer")
            s.run{try await s.switchOutput(client,to:"phone")};try await Task.sleep(for:.milliseconds(80))
            checks["transferShowsRequestedPhoneWhileOriginRemainsTV"]=s.displayedOutput()=="phone" && s.currentOutput=="tv" && s.busy
            do{try await s.playbackAction(client,"pause");checks["pendingDestinationBlocksControlCommands"]=false}catch{checks["pendingDestinationBlocksControlCommands"]=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}==before+1}
            s.cancel(client);try await settle(s)
            checks["cancelledTransferKeepsOrigin"]=s.currentOutput=="tv" && s.preparingOutput==nil && !s.phone.ready && s.error==nil
            let failed=PlaybackSession();failed.status=s.status;failed.phone.player.isMuted=true
            DestinationFixtureProtocol69.state.setMode("fail-media");failed.startPhone(client,presentationID:UUID(),selection:selection,position:nil,item:item);try await settle(failed)
            checks["failedPhonePreparationDoesNotRevertToMac"]=failed.currentOutput=="phone" && !failed.phone.ready && failed.error != nil && failed.preparingOutput==nil
            DestinationFixtureProtocol69.state.setMode("slow-media");let cancelled=PlaybackSession();cancelled.status=s.status;cancelled.phone.player.isMuted=true
            cancelled.startPhone(client,presentationID:UUID(),selection:selection,position:nil,item:item);try await Task.sleep(for:.milliseconds(80));cancelled.cancel(client);try await settle(cancelled)
            checks["cancelledPreparationKeepsPhoneSelection"]=cancelled.currentOutput=="phone" && !cancelled.phone.ready && cancelled.preparingOutput==nil && cancelled.error==nil
            DestinationFixtureProtocol69.state.setMode("normal");cancelled.startPhone(client,presentationID:UUID(),selection:selection,position:nil,item:item);try await settle(cancelled);try await Task.sleep(for:.milliseconds(850))
            checks["newPhonePreparationSurvivesLateCancelledReply"]=cancelled.currentOutput=="phone" && cancelled.phone.ready && cancelled.error==nil
            cancelled.phone.stop(client)
            let legacy=PlaybackSession();legacy.status=PlaybackStatus(state:"paused",position:0.75,duration:2,title:"Inert Mac",output:"mac");legacy.phone.player.isMuted=true
            try await legacy.switchLegacyOutput(client,to:"phone")
            checks["legacyPhoneHandoffSelectsPhone"]=legacy.currentOutput=="phone" && legacy.phone.ready
            try await legacy.switchLegacyOutput(client,to:"mac")
            checks["legacyMacHandoffSelectsMac"]=legacy.currentOutput=="mac" && !legacy.phone.ready
            checks["noUnexpectedMacControlCommands"]=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}==before+1
            result=checks.values.allSatisfy{$0} ? "Playback destination checks passed":"A playback destination check failed"
        }catch{result=error.localizedDescription;checks["completedWithoutError"]=false}
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let report:[String:Any]=["checks":checks,"result":result,"externalNetworkRequests":0,"physicalMediaCommands":0]
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("playback-destination69.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
/// Serves only a generated local test asset; any unexpected URL fails closed.
final class FullscreenLocalAssetProtocol70:URLProtocol,@unchecked Sendable{
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){do{
        guard request.url?.host=="fullscreen70.invalid" else{throw URLError(.unsupportedURL)}
        if let file=request.url?.lastPathComponent,["m3u8","ts","vtt"].contains(request.url?.pathExtension ?? ""){
            let bytes=try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("fullscreen70-HLS/"+file))
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":file.hasSuffix("m3u8") ? "application/vnd.apple.mpegurl":file.hasSuffix("vtt") ? "text/vtt":"video/mp2t"])!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:bytes);client?.urlProtocolDidFinishLoading(self);return
        }
        let bytes=try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("fullscreen70.mp4"))
        let range=request.value(forHTTPHeaderField:"Range")?.replacingOccurrences(of:"bytes=",with:"").split(separator:"-",omittingEmptySubsequences:false)
        let start=Int(range?.first ?? "0") ?? 0,end=min(bytes.count-1,Int(range?.last ?? "") ?? bytes.count-1)
        guard start>=0,start<=end else{throw URLError(.badServerResponse)}
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:206,httpVersion:nil,headerFields:["Content-Type":"video/mp4","Content-Range":"bytes \(start)-\(end)/\(bytes.count)"])!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:bytes.subdata(in:start..<(end+1)));client?.urlProtocolDidFinishLoading(self)
    }catch{client?.urlProtocol(self,didFailWithError:error)}}
    override func stopLoading(){}
}
@MainActor struct FullscreenLifecycleChecks70:View{
    @State private var result="Checking fullscreen and lifecycle…"
    var body:some View{Text(result).padding().task{await check()}}
    private func require(_ condition:Bool,_ message:String)throws{if !condition{throw RemoteFailure(message:message)}}
    private func settle(_ owner:PlaybackSession)async throws{let deadline=ContinuousClock.now.advanced(by:.seconds(12));while owner.busy{try require(ContinuousClock.now<deadline,"Native fixture timed out");try await Task.sleep(for:.milliseconds(20))}}
    private func check()async{
        var checks:[String:Bool]=[:]
        do{
            let controls=FullscreenControls(delay:.milliseconds(100))
            var context=FullscreenControls.Context(active:true,playing:true)
            controls.update(context);try await Task.sleep(for:.milliseconds(150))
            checks["playingHidesAfterInactivity"] = !controls.visible && !controls.timerScheduled
            controls.videoTapped();checks["hiddenVideoTapRevealsControls"]=controls.visible && controls.timerScheduled
            try await Task.sleep(for:.milliseconds(60));controls.interaction("seek",active:true);try await Task.sleep(for:.milliseconds(130))
            checks["scrubbingRetainsControls"]=controls.visible && !controls.timerScheduled
            controls.interaction("volume",active:true);controls.interaction("seek",active:false);try await Task.sleep(for:.milliseconds(130))
            checks["overlappingInteractionRemainsVisible"]=controls.visible
            controls.interaction("volume",active:false);try await Task.sleep(for:.milliseconds(150))
            checks["releaseRestartsIdleDeadline"] = !controls.visible
            context.playing=false;controls.update(context);controls.videoTapped();try await Task.sleep(for:.milliseconds(130))
            checks["pausedControlsStayVisible"]=controls.visible && !controls.timerScheduled
            context.playing=true;context.blocked=true;controls.update(context);try await Task.sleep(for:.milliseconds(130))
            checks["bufferingErrorsAndSheetsHoldControls"]=controls.visible && !controls.timerScheduled
            context.blocked=false;context.accessible=true;controls.update(context);try await Task.sleep(for:.milliseconds(130))
            checks["VoiceOverAndSwitchControlRetainButtons"]=controls.visible && !controls.timerScheduled
            context.accessible=false;controls.update(context);controls.videoTapped();checks["videoTapCanHideWhilePlaying"] = !controls.visible
            controls.reveal();context.active=false;controls.update(context);try await Task.sleep(for:.milliseconds(150))
            checks["portraitExitCancelsFullscreenDeadline"]=controls.visible && !controls.timerScheduled
            context.active=true;controls.update(context);try await Task.sleep(for:.milliseconds(60));controls.reveal();try await Task.sleep(for:.milliseconds(60))
            checks["revealInvalidatesOldDeadline"]=controls.visible
            controls.stop();try await Task.sleep(for:.milliseconds(150));checks["dismissalCancelsTimer"]=controls.visible && !controls.timerScheduled && !controls.context.active
            controls.update(context);controls.interaction("interrupted-seek",active:true);controls.stop();controls.update(context);try await Task.sleep(for:.milliseconds(150));checks["InterruptedScrubDoesNotPinControlsAfterReentry"] = !controls.visible
            let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[DestinationFixtureProtocol69.self]
            let remote=RemoteClient(baseURL:URL(string:"https://fullscreen70.local")!,session:URLSession(configuration:config))
            let local=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:StandaloneService())
            let hlsRemote=RemoteClient(baseURL:URL(string:"https://fullscreen-hls70.local")!,session:URLSession(configuration:config))
            for (name,client,id) in [("MacBackedMP4",remote,900000070),("StandaloneMP4",local,900000070),("MacBackedHLS",hlsRemote,900000071),("StandaloneHLS",local,900000071)]{
                DestinationFixtureProtocol69.state.setMode("normal")
                let owner=PlaybackSession();owner.phone.player.isMuted=true;owner.phone.player.volume=0
                owner.startPhone(client,presentationID:UUID(),selection:.init(kind:"movie",contentID:id,season:nil,episode:nil),position:1,item:nil)
                try await settle(owner);try require(owner.phone.ready,"Phone fixture did not become ready: "+name)
                let lease=try owner.phone.transferSnapshot().handle
                let player=owner.phone.player,item=player.currentItem
                let activity=FullscreenPlayerActivity();activity.observe(player)
                try await owner.playbackAction(client,"resume");try await Task.sleep(for:.milliseconds(180))
                checks[name+"NativeActivityObservesPlaying"]=activity.playing
                let position=player.currentTime().seconds
                let counters=DestinationFixtureProtocol69.state.lock.withLock{(DestinationFixtureProtocol69.state.prepares,DestinationFixtureProtocol69.state.phoneStarts)}
                owner.applicationDidBackground(client);try await Task.sleep(for:.milliseconds(80));await owner.applicationDidBecomeActive(client)
                try await Task.sleep(for:.milliseconds(100))
                checks[name+"ForegroundKeepsPlayerAndItem"]=owner.phoneActive && owner.phone.ready && owner.phone.player===player && player.currentItem===item
                checks[name+"ForegroundDoesNotRewind"]=player.currentTime().seconds>=position-0.02
                checks[name+"ForegroundResumesPlayingIntent"]=player.rate>0
                try await owner.playbackAction(client,"pause");owner.applicationDidBackground(client);await owner.applicationDidBecomeActive(client)
                checks[name+"PausedIntentSurvivesForeground"]=player.rate==0
                let saved=player.currentTime().seconds;owner.applicationDidBackground(client);player.replaceCurrentItem(with:nil);await owner.applicationDidBecomeActive(client)
                checks[name+"SuspendedAssetRestoresSamePlayerAndPosition"]=owner.phone.ready && owner.phone.player===player && player.currentTime().seconds>=saved-0.02 && player.rate==0
                let after=DestinationFixtureProtocol69.state.lock.withLock{(DestinationFixtureProtocol69.state.prepares,DestinationFixtureProtocol69.state.phoneStarts)}
                let recoveredLease=try owner.phone.transferSnapshot().handle
                checks[name+"NoDuplicatePrepareOrPhoneStart"]=lease==recoveredLease && counters.0==after.0 && counters.1==after.1
                activity.stop();checks[name+"ObservationStopsOnDismiss"] = !activity.playing
                owner.phone.stop(client)
            }
            let owner=PlaybackSession();owner.status=PlaybackStatus(state:"playing",position:40,duration:100,title:"Original Mac identity",output:"mac")
            let mode=ApplicationModeModel();mode.routingPreference="automatic";mode.mode = .remote;mode.playback=owner
            checks["AutomaticFallbackPreservesRemotePlaybackContext"] = !mode.safeAutomaticBoundary
            let commands=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}
            owner.applicationDidBackground(remote);DestinationFixtureProtocol69.state.setMode("status-offline");await owner.applicationDidBecomeActive(remote)
            checks["ConnectionLossRetainsMacIdentityAndPosition"]=owner.status?.title=="Original Mac identity" && owner.status?.position==40 && owner.connectionMessage != nil
            DestinationFixtureProtocol69.state.setMode("status-tv");await owner.refreshRemoteStatus(remote)
            checks["ForegroundReconcilesActualTVDestination"]=owner.currentOutput=="tv" && owner.status?.position==88 && owner.connectionMessage==nil
            owner.applicationDidBackground(remote);DestinationFixtureProtocol69.state.setMode("status-idle");await owner.applicationDidBecomeActive(remote)
            checks["OneWarmupIdleSnapshotDoesNotEraseSession"]=owner.currentOutput=="tv" && owner.status?.position==88
            await owner.refreshRemoteStatus(remote);checks["ConfirmedIdleIsAccepted"]=owner.status?.state=="idle"
            DestinationFixtureProtocol69.state.setMode("status-slow");let stale=Task{await owner.refreshRemoteStatus(remote)};try await Task.sleep(for:.milliseconds(50));owner.applicationDidBackground(remote)
            DestinationFixtureProtocol69.state.setMode("status-tv");await owner.applicationDidBecomeActive(remote);await stale.value
            checks["StalePreBackgroundStatusCannotOverwriteForeground"]=owner.currentOutput=="tv" && owner.status?.title=="Actual inert TV"
            checks["LifecycleNeverStartsMacOrTV"]=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.commands}==commands
            result=checks.values.allSatisfy{$0} ? "Fullscreen/lifecycle checks passed":"Fullscreen/lifecycle check failed"
        }catch{checks["completedWithoutError"]=false;result=error.localizedDescription}
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        let report:[String:Any]=["checks":checks,"result":result,"externalNetworkRequests":0,"physicalMediaCommands":0,"backgroundRelaySupport":"Not claimed; a phone-hosted relay requires foreground execution","hlsFixtureResourceIDs":DestinationFixtureProtocol69.state.lock.withLock{Array(DestinationFixtureProtocol69.state.hlsIDs).sorted()}]
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("fullscreen-lifecycle70.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
@MainActor struct CaptionsControlsChecks71:View{
    let mode:String
    @State private var result="Checking captions and compact audio…"
    @State private var owner=PlaybackSession()
    private let config:URLSessionConfiguration={let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[DestinationFixtureProtocol69.self];return c}()
    var body:some View{Group{if mode=="captions-controls71"{Text(result).padding()}else{RemoteControlView(client:local).environment(\.playbackSession,owner)}}.task{await check()}}
    private var local:RemoteClient{RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:StandaloneService())}
    private func require(_ value:Bool,_ message:String)throws{if !value{throw RemoteFailure(message:message)}}
    private func ready(_ owner:PlaybackSession)async throws{let end=ContinuousClock.now.advanced(by:.seconds(12));while owner.busy || owner.phone.captions.loading{try require(ContinuousClock.now<end,"Subtitle fixture timed out");try await Task.sleep(for:.milliseconds(30))};try require(owner.phone.ready,"Native source did not prepare: \(owner.error ?? "no detail")")}
    private func selection(_ captions:NativeCaptionsModel,_ id:String?)async throws{try captions.select(id);try await Task.sleep(for:.milliseconds(250))}
    private func check()async{
        var checks:[String:Bool]=[:]
        do{
            if mode != "captions-controls71"{owner.startPhone(local,presentationID:UUID(),selection:.init(kind:"movie",contentID:900000071,season:nil,episode:nil),position:1);try await ready(owner);return}
            let remote=RemoteClient(baseURL:URL(string:"https://captions71.local")!,session:URLSession(configuration:config))
            let hls=RemoteClient(baseURL:URL(string:"https://captions-hls71.local")!,session:URLSession(configuration:config))
            for (name,client,id) in [("MacBackedNative",remote,900000070),("StandaloneNative",local,900000070),("MacBackedExternalHLS",hls,900000071),("StandaloneExternalHLS",local,900000071)]{
                let owner=PlaybackSession();owner.startPhone(client,presentationID:UUID(),selection:.init(kind:"movie",contentID:id,season:nil,episode:nil),position:1)
                try await ready(owner);let captions=owner.phone.captions
                checks[name+"DiscoversSelectableTracks"] = !captions.tracks.isEmpty
                try require(!captions.tracks.isEmpty,"No caption group discovered in \(name)")
                let track=captions.tracks[0];try await selection(captions,track.id)
                checks[name+"SelectionReadsActualNativeState"]=captions.selectedID==track.id
                try await selection(captions,nil)
                let item=owner.phone.player.currentItem!
                let group=try await item.asset.loadMediaSelectionGroup(for:.legible)
                checks[name+"OffActuallyClearsLegibleSelection"]=captions.selectedID==nil && group.map{item.currentMediaSelection.selectedMediaOption(in:$0)==nil}==true
                checks[name+"OffDoesNotDisableAutomaticAudio"]=owner.phone.player.appliesMediaSelectionCriteriaAutomatically
                owner.applicationDidBackground(client);owner.phone.player.replaceCurrentItem(with:nil);await owner.applicationDidBecomeActive(client)
                let end=ContinuousClock.now.advanced(by:.seconds(3));while captions.loading,ContinuousClock.now<end{try await Task.sleep(for:.milliseconds(30))}
                checks[name+"OffSurvivesForegroundRebuild"]=owner.phone.ready && captions.selectedID==nil && !captions.loading
                try await owner.setVolume(client,0.37);try await owner.setMuted(client,true)
                checks[name+"VolumeAndMuteReachNativePlayer"]=abs(owner.phone.player.volume-0.37)<0.01 && owner.phone.player.isMuted
                try await owner.setMuted(client,false);checks[name+"UnmuteIsOneAction"] = !owner.phone.player.isMuted
                owner.phone.stop(client)
            }
            let controls=FullscreenControls(delay:.milliseconds(80));var context=FullscreenControls.Context(active:true,playing:true,blocked:true)
            controls.update(context);try await Task.sleep(for:.milliseconds(130));checks["OpenCaptionsOrVolumeKeepsFullscreenVisible"]=controls.visible && !controls.timerScheduled
            context.blocked=false;controls.update(context);try await Task.sleep(for:.milliseconds(130));checks["DismissingPanelRestartsAutoHide"] = !controls.visible
            controls.reveal();controls.interaction("volume",active:true);try await Task.sleep(for:.milliseconds(130));checks["SliderDragKeepsControlsUsable"]=controls.visible;controls.stop()
            let audio=GCKMediaTrack(identifier:4,contentIdentifier:nil,contentType:"audio/aac",type:.audio,textSubtype:.unknown,name:"Audio",languageCode:"en",customData:nil)!
            let text=GCKMediaTrack(identifier:7,contentIdentifier:nil,contentType:"text/vtt",type:.text,textSubtype:.subtitles,name:"English",languageCode:"en",customData:nil)!
            let tracks=[audio,text]
            checks["TVOffPreservesActiveAudio"]=try StandaloneCastModel.captionTrackIDs(tracks,active:[4,7],selected:nil)==[4]
            checks["TVTrackSelectionPreservesActiveAudio"]=try StandaloneCastModel.captionTrackIDs(tracks,active:[4],selected:"7")==[4,7]
            do{_ = try StandaloneCastModel.captionTrackIDs(tracks,active:[4],selected:"99");checks["TVRejectsStaleTrack"]=false}catch{checks["TVRejectsStaleTrack"]=true}
            let mac=PlaybackSession();mac.status=PlaybackStatus(state:"playing",position:1,duration:30,title:"Synthetic",output:"mac",volume:0.4,isMuted:false,audioControl:true)
            try await mac.setVolume(remote,0.23);try await mac.setMuted(remote,true)
            checks["MacAudioRoutesThroughRemoteCommands"]=mac.status?.volume==0.23 && mac.status?.isMuted==true && DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.audioOutputs.suffix(2)==["mac","mac"]}
            mac.status=PlaybackStatus(state:"playing",position:1,duration:30,output:"tv",audioControl:true)
            try await mac.setVolume(remote,0.42)
            checks["MacBackedTVAudioRoutesToTV"]=DestinationFixtureProtocol69.state.lock.withLock{DestinationFixtureProtocol69.state.audioOutputs.last}=="tv"
            mac.status=PlaybackStatus(state:"playing",position:1,duration:30,output:"tv",audioControl:false)
            do{try await mac.setMuted(remote,true);checks["LockedAudioIsRejected"]=false}catch{checks["LockedAudioIsRejected"]=true}
            let empty=NativeCaptionsModel();empty.attach(AVPlayerItem(url:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("no-captions71.mp4")))
            let end=ContinuousClock.now.advanced(by:.seconds(3));while empty.loading,ContinuousClock.now<end{try await Task.sleep(for:.milliseconds(30))}
            checks["NoTracksDoesNotInventSelectableCaptions"]=empty.tracks.isEmpty && empty.selectedID==nil
            result=checks.values.allSatisfy{$0} ? "Captions and audio checks passed":"A captions/audio check failed"
            if mode != "captions-controls71"{owner.startPhone(local,presentationID:UUID(),selection:.init(kind:"movie",contentID:900000071,season:nil,episode:nil),position:1);try await ready(owner);owner.phone.player.play()}
        }catch{checks["completedWithoutError"]=false;result=error.localizedDescription}
        let report:[String:Any]=["checks":checks,"result":result,"externalProviderRequests":0,"physicalMediaCommands":0]
        let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:folder.appendingPathComponent("captions-controls71.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
final class IdentityFixtureProtocol72:URLProtocol,@unchecked Sendable{
    private final class State:@unchecked Sendable{let lock=NSLock();var mode="normal";var handles:[String:Int]=[:];var served:Set<Int>=[];var unexpectedMediaRequests=0}
    private static let state=State()
    static func mode(_ mode:String){state.lock.withLock{state.mode=mode}}
    static var currentMode:String{state.lock.withLock{state.mode}}
    static var unexpectedMediaRequests:Int{state.lock.withLock{state.unexpectedMediaRequests}}
    private func raw(_ data:Data,type:String,status:Int=200,headers:[String:String]=[:]){guard !lock.withLock({stopped}) else{return};client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:headers.merging(["Content-Type":type]){$1})!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)}
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    private var stopped=false
    private let lock=NSLock()
    private func reply(_ value:[String:Any],status:Int=200){guard !lock.withLock({stopped}) else{return};client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:try! JSONSerialization.data(withJSONObject:value));client?.urlProtocolDidFinishLoading(self)}
    override func startLoading(){
        var bytes=request.httpBody ?? Data();if bytes.isEmpty,let stream=request.httpBodyStream{stream.open();defer{stream.close()};var buffer=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable{let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};bytes.append(contentsOf:buffer.prefix(n))}}
        let body=((try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any]) ?? [:],operation=body["operation"] as? String ?? "",path=request.url!.path,mode=Self.state.lock.withLock{Self.state.mode}
        if path=="/remote/v1/progress"{DispatchQueue.global().asyncAfter(deadline:.now()+0.3){[self] in reply(operation=="begin" ? ["sessionID":"identity-progress"]:["ok":true])};return}
        if request.url?.host=="api.2embed.cc"{reply(["tmdb_id":1514026,"imdb_id":"tt37281055","title":"Buddy","release_date":"2026-08-27","year":"2026"]);return}
        if request.url?.host=="www.2embed.cc"{raw(Data("<iframe id='iframesrc' data-src='https://streamsrcs.2embed.cc/swish?id=trjx4lq02ty7'></iframe>".utf8),type:"text/html");return}
        if request.url?.host=="2vcdn.skin",path.hasPrefix("/e/"){do{raw(try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("buddy72-player.html")),type:"text/html")}catch{reply(["error":"Missing captured Buddy page"],status:500)};return}
        if request.url?.host=="identity72.invalid"{do{
            let data=try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent(path.contains("red") ? "identity72-red.mp4":"identity72-blue.mp4"))
            let range=(request.value(forHTTPHeaderField:"Range") ?? "bytes=0-").dropFirst(6).split(separator:"-",omittingEmptySubsequences:false),offset=Int(range.first ?? "0") ?? 0,end=min(data.count-1,Int(range.last ?? "") ?? data.count-1)
            raw(data.subdata(in:offset..<(end+1)),type:"video/mp4",status:206,headers:["Content-Range":"bytes \(offset)-\(end)/\(data.count)"])
        }catch{reply(["error":"Missing native fixture"],status:500)};return}
        if request.url?.host=="play.xpass.top"{reply(["error":"Synthetic XPS unavailable"],status:503);return}
        if request.url?.host != "identity72.local"{Self.state.lock.withLock{Self.state.unexpectedMediaRequests+=1};reply(["error":"Unexpected provider media request"],status:500);return}
        guard path=="/remote/v1/media" else{reply(["features":[]]);return}
        if operation=="prepare"{
            let selection=body["selection"] as? [String:Any] ?? [:],id=selection["contentID"] as? Int ?? 0
            if id==73,mode=="fail-blue"{DispatchQueue.global().asyncAfter(deadline:.now()+0.35){[self] in reply(["code":"SYNTHETIC_BLUE_UNAVAILABLE"],status:503)};return}
            let handle=UUID().uuidString;Self.state.lock.withLock{Self.state.handles[handle]=id}
            var returned=selection;if mode=="mismatch-blue",id==73{returned["contentID"]=72}
            let data=try! JSONSerialization.data(withJSONObject:["handle":handle,"title":id==72 ? "Red title":"Blue title","position":1,"duration":8,"paused":true,"format":"mp4","mode":"direct","sourceInfo":["selection":returned]])
            if mode=="slow-blue",id==73{DispatchQueue.global().asyncAfter(deadline:.now()+0.35){[self] in reply((try! JSONSerialization.jsonObject(with:data)) as! [String:Any])}}else{reply((try! JSONSerialization.jsonObject(with:data)) as! [String:Any])};return
        }
        let handle=body["handle"] as? String ?? "",id=Self.state.lock.withLock{Self.state.handles[handle] ?? 0}
        if operation=="chunk"{do{guard id==72 || id==73 else{throw URLError(.badURL)};let data=try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent(id==72 ? "identity72-red.mp4":"identity72-blue.mp4"));let offset=body["offset"] as? Int ?? 0,count=body["length"] as? Int ?? 2;_ = Self.state.lock.withLock{Self.state.served.insert(id)};reply(["bytes":data.subdata(in:offset..<min(data.count,offset+count)).base64EncodedString(),"offset":offset,"total":data.count])}catch{reply(["code":"SYNTHETIC_MISSING_ASSET"],status:500)};return}
        if operation=="phone-ready"{reply(["ok":true,"status":["state":"prepared","position":1,"duration":8],"transfer":["position":1,"paused":true]]);return}
        if operation=="next-source"{reply(["code":"SYNTHETIC_NO_OTHER_SOURCE"],status:503);return}
        if ["close","cancel-prepare"].contains(operation){_ = Self.state.lock.withLock{Self.state.handles.removeValue(forKey:handle)}}
        reply(["ok":true])
    }
    override func stopLoading(){lock.withLock{stopped=true}}
}
@MainActor struct PlaybackIdentityChecks72:View{
    @State private var result="Checking actual video identity…"
    var body:some View{Text(result).padding().task{await check()}}
    private func require(_ value:Bool,_ message:String)throws{if !value{throw RemoteFailure(message:message)}}
    private func wait(_ session:PlaybackSession)async throws{let deadline=ContinuousClock.now.advanced(by:.seconds(10));while session.busy{try require(ContinuousClock.now<deadline,"Identity fixture timed out");try await Task.sleep(for:.milliseconds(20))}}
    private func frame(_ phone:PhonePlaybackModel)async throws->String{
        guard let asset=phone.player.currentItem?.asset else{return "none"}
        let generator=AVAssetImageGenerator(asset:asset);let (image,_)=try await generator.image(at:CMTime(seconds:1,preferredTimescale:600))
        var rgba=[UInt8](repeating:0,count:4)
        rgba.withUnsafeMutableBytes{bytes in if let context=CGContext(data:bytes.baseAddress,width:1,height:1,bitsPerComponent:8,bytesPerRow:4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue|CGBitmapInfo.byteOrder32Big.rawValue){context.draw(image,in:CGRect(x:0,y:0,width:1,height:1))}}
        return rgba[0]>rgba[2] ? "red":"blue"
    }
    private func check()async{
        var checks:[String:Bool]=[:],observed:[String:String]=[:]
        do{
            let configuration=URLSessionConfiguration.ephemeral;configuration.protocolClasses=[IdentityFixtureProtocol72.self]
            let client=RemoteClient(baseURL:URL(string:"https://identity72.local")!,session:URLSession(configuration:configuration))
            let red=PhonePlaybackSelection(kind:"movie",contentID:72,season:nil,episode:nil),blue=PhonePlaybackSelection(kind:"movie",contentID:73,season:nil,episode:nil)
            let owner=PlaybackSession()
            owner.startPhone(client,presentationID:UUID(),selection:red,position:1);try await wait(owner)
            observed["firstSelectedTitleFrame"]=try await frame(owner.phone);checks["FirstTitleDecodesItsOwnActualFrames"]=observed["firstSelectedTitleFrame"]=="red"
            owner.startPhone(client,presentationID:UUID(),selection:blue,position:1);try await wait(owner)
            observed["secondSelectedTitleFrame"]=try await frame(owner.phone);checks["SecondTitleDecodesDifferentActualFrames"]=observed["secondSelectedTitleFrame"]=="blue"
            owner.startPhone(client,presentationID:UUID(),selection:red,position:1);try await wait(owner)
            IdentityFixtureProtocol72.mode("fail-blue")
            owner.startPhone(client,presentationID:UUID(),selection:blue,position:1,item:RemoteTitle(id:"73",kind:"movie",title:"Blue title",overview:"",posterURL:nil));try await Task.sleep(for:.milliseconds(80));owner.applicationDidBackground(client);try await wait(owner);await owner.applicationDidBecomeActive(client)
            observed["failedNewTitleForegroundFrame"]=try await frame(owner.phone)
            checks["FailedNewTitleNeverRestoresPreviousTitlesLease"] = !owner.phone.ready && owner.phone.player.currentItem==nil
            owner.phone.stop(client);IdentityFixtureProtocol72.mode("normal")
            let model=PhonePlaybackModel();await model.prepare(client,selection:red,position:1);model.progress.enabled=true;model.recordProgress(client,force:true)
            let pending=Task{await model.prepare(client,selection:blue,position:1)};try await Task.sleep(for:.milliseconds(40));model.stop(client);await pending.value
            observed["cancelledPrepareAfterProgressFlushFrame"]=try await frame(model)
            checks["StoppedPreparationCannotRestartAfterProgressFlush"] = !model.ready && model.player.currentItem==nil
            model.stop(client)
            IdentityFixtureProtocol72.mode("mismatch-blue");await model.prepare(client,selection:blue,position:1)
            checks["MismatchedReturnedTitleIdentityIsRejected"] = !model.ready && model.player.currentItem==nil && model.error?.contains("different title")==true
            IdentityFixtureProtocol72.mode("normal");await model.prepare(client,selection:red,position:1)
            let firstURL=(model.player.currentItem?.asset as? AVURLAsset)?.url
            await model.prepare(client,selection:blue,position:1)
            checks["DifferentLeasesUseDifferentNativeAssetAddresses"]=firstURL != (model.player.currentItem?.asset as? AVURLAsset)?.url
            IdentityFixtureProtocol72.mode("slow-blue")
            let late=Task{await model.prepare(client,selection:blue,position:1)};try await Task.sleep(for:.milliseconds(50));await model.prepare(client,selection:red,position:1);await late.value
            observed["latePreviousSelectionFrame"]=try await frame(model)
            checks["LatePreviousSelectionCannotReplaceNewerVideo"]=model.ready && observed["latePreviousSelectionFrame"]=="red" && model.title=="Red title"
            model.stop(client);IdentityFixtureProtocol72.mode("normal")
            let buddyHTML=try String(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("buddy72-player.html"),encoding:.utf8)
            do{try StandaloneSwishPage.verifyIdentity(html:buddyHTML,expectedTitles:["Buddy"],expectedYear:2026);checks["ActualBuddy2024ProviderResponseRejectedForBuddy2026"]=false}catch{checks["ActualBuddy2024ProviderResponseRejectedForBuddy2026"]=error.localizedDescription.contains("2024 instead of 2026")}
            let standalone=StandaloneService(),standaloneClient=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:standalone)
            do{_ = try await standalone.resolve(kind:"movie",id:1514026,season:1,episode:1);checks["StandaloneBuddyResolverRejectsWrongReleaseBeforeVideoRequest"]=false}catch{checks["StandaloneBuddyResolverRejectsWrongReleaseBeforeVideoRequest"]=error.localizedDescription.contains("Buddy (2026)") && IdentityFixtureProtocol72.unexpectedMediaRequests==0}
            let localOwner=PlaybackSession();localOwner.startPhone(standaloneClient,presentationID:UUID(),selection:red,position:1);try await wait(localOwner)
            checks["StandaloneFirstTitleActualFramesMatch"]=try await frame(localOwner.phone)=="red"
            localOwner.startPhone(standaloneClient,presentationID:UUID(),selection:blue,position:1);try await wait(localOwner)
            checks["StandaloneSecondTitleActualFramesMatch"]=try await frame(localOwner.phone)=="blue"
            localOwner.startPhone(standaloneClient,presentationID:UUID(),selection:red,position:1);try await wait(localOwner);IdentityFixtureProtocol72.mode("fail-blue")
            localOwner.startPhone(standaloneClient,presentationID:UUID(),selection:blue,position:1);try await Task.sleep(for:.milliseconds(60));localOwner.applicationDidBackground(standaloneClient);try await wait(localOwner);await localOwner.applicationDidBecomeActive(standaloneClient)
            checks["StandaloneFailedNewTitleNeverRecoversOldLease"] = !localOwner.phone.ready && localOwner.phone.player.currentItem==nil
            localOwner.phone.stop(standaloneClient);IdentityFixtureProtocol72.mode("normal")
            for (name,html,expectedTitle,year,allowed) in [("CorrectRelease", "<title>Buddy 2026 1080p WEBRip</title>","Buddy",2026,true),("SameNameWrongRelease","<title>Buddy 1997 1080p</title>","Buddy",2026,false),("WrongMovieSameYear","<title>Another Movie 2026 1080p</title>","Buddy",2026,false),("YearInMovieTitle","<title>2001 A Space Odyssey 1968 1080p</title>","2001: A Space Odyssey",1968,true),("UnidentifiedRelease","<title>Video player</title>","Buddy",2026,false)]{
                do{try StandaloneSwishPage.verifyIdentity(html:html,expectedTitles:[expectedTitle],expectedYear:year);checks[name+"Validation"]=allowed}catch{checks[name+"Validation"] = !allowed}
            }
            result=checks.values.allSatisfy{$0} ? "Playback identity checks passed":"Playback identity regression reproduced"
        }catch{checks["completedWithoutError"]=false;result=error.localizedDescription}
        let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];let report:[String:Any]=["checks":checks,"observedFrames":observed,"result":result,"externalProviderRequests":0,"physicalMediaCommands":0];if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:folder.appendingPathComponent("playback-identity72.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
import CryptoKit
import CoreImage
final class SourceFallbackProtocol73:URLProtocol,@unchecked Sendable {
    private final class State:@unchecked Sendable{let lock=NSLock();var mode="success";var xps=0;var vip=0;var external76=0}
    private static let state=State()
    static func reset(_ mode:String){state.lock.withLock{state.mode=mode;state.xps=0;state.vip=0;state.external76=0}}
    static var external76:Int{state.lock.withLock{state.external76}}
    static var counts:(Int,Int){state.lock.withLock{(state.xps,state.vip)}}
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    private func reply(_ data:Data,type:String="application/json",status:Int=200){client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":type])!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)}
    private func json(_ data:[String:Any],status:Int=200){reply(try! JSONSerialization.data(withJSONObject:data),status:status)}
    override func startLoading(){
        let url=request.url!,mode=Self.state.lock.withLock{Self.state.mode}
        if mode.hasPrefix("tv76"){
            if url.host=="api.2embed.cc"{json(["tmdb_id":1399,"imdb_id":"tt0944947","name":"Game of Thrones"]);return}
            if url.host=="www.2embed.cc"{reply(Data("<iframe id='iframesrc' data-src='https://vidsrc.buzz/embed/tv/1399/1/1'></iframe>".utf8),type:"text/html");return}
            if url.host=="vidsrc.buzz"{
                if url.path.hasSuffix("api.php"){json(["url":"https://external-vsrc76.invalid/manifest.txt","type":"hls"])}else{reply(Data(("var Q={\"type\":\"tv\",\"id\":1399,\"s\":1,\"e\":"+(mode=="tv76-wrong-config-episode" ? "2":"1")+",\"t\":\"inert\",\"ssr\":{\"servers\":[{\"ref\":\"inert\",\"name\":\"Fixture\"}]}};").utf8),type:"text/html")};return
            }
            if url.host=="play.xpass.top"{
                Self.state.lock.withLock{Self.state.xps+=1}
                if mode=="tv76-xps-refused"{json(["error":"Inert refusal"],status:403);return}
                if url.path.hasPrefix("/e/"){reply(Data(("var dataUrl=\"/data/tv/1399/1/"+(mode=="tv76-wrong-data-episode" ? "2":"1")+"?token=inert76\";").utf8),type:"text/html");return}
                if url.path.hasPrefix("/data/"){
                    do{let plain=try JSONSerialization.data(withJSONObject:[["name":"VIP 1","url":"/vip/inert76/playlist.json"]]);let key=SymmetricKey(data:Data(SHA256.hash(data:Data(("spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|"+url.path+"|inert76").utf8))));let box=try AES.GCM.seal(plain,using:key);reply(Data(box.combined!.base64EncodedString().utf8),type:"text/plain")}catch{json(["error":"Inert encoding failure"],status:500)};return
                }
                json(["playlist":[["sources":[["file":"https://vip.1x2.space/inert76/master.m3u8","type":"hls","label":"1080p"]]]]]);return
            }
            if url.host=="vip.1x2.space"{
                Self.state.lock.withLock{Self.state.vip+=1}
                let manifest="#EXTM3U\n"+(mode=="tv76-encrypted" ? "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n":"")+"#EXT-X-TARGETDURATION:30\n#EXTINF:30,\npart.ts\n"+(mode=="tv76-live" ? "":"#EXT-X-ENDLIST\n")
                reply(Data(manifest.utf8),type:"application/vnd.apple.mpegurl");return
            }
            Self.state.lock.withLock{Self.state.external76+=1};json(["error":"Unexpected external request"],status:500);return
        }
        if url.host=="api.2embed.cc",URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems?.contains(where:{$0.name=="tmdb_id" && $0.value=="27205"})==true{json(["tmdb_id":27205,"imdb_id":"tt1375666","title":"Inception","release_date":"2010-07-15","year":"2010","runtime":148]);return}
        if url.host=="www.2embed.cc",url.path.contains("tt1375666"){reply(Data("<iframe id='iframesrc' data-src='https://videm.xyz/movie/27205'></iframe>".utf8),type:"text/html");return}
        if url.host=="videm.xyz"{
            if url.path=="/api.php"{json(["url":"https://videm.xyz/stream/fixture-inception.m3u8","type":"hls"])}else{reply(Data(#"var Q={"type":"movie","id":27205,"s":0,"e":0,"t":"fixture","ssr":{"servers":[{"ref":"fixture","name":"Fixture"}]}};"#.utf8),type:"text/html")};return
        }
        if url.host=="api.2embed.cc"{json(["tmdb_id":1514026,"imdb_id":"tt37281055","title":"Buddy","release_date":"2026-08-27","year":"2026","runtime":96]);return}
        if url.host=="www.2embed.cc"{reply(Data("<iframe id='iframesrc' data-src='https://streamsrcs.2embed.cc/swish?id=fixtureBuddy73'></iframe>".utf8),type:"text/html");return}
        if url.host=="2vcdn.skin"{reply(Data("<title>Buddy 2024 1080p WEBRip</title>".utf8),type:"text/html",status:mode=="swish-refused" ? 403:200);return}
        if url.host=="play.xpass.top"{
            Self.state.lock.withLock{Self.state.xps+=1}
            if mode=="xps-offline"{json(["error":"Synthetic unavailable"],status:503);return}
            if url.path.hasPrefix("/e/"){reply(Data(("var dataUrl=\"/data/movie/"+(mode=="wrong-id" ? "999999":"1514026")+"?token=fixture73\";").utf8),type:"text/html");return}
            if url.path.hasPrefix("/data/"){do{
                let plain=try JSONSerialization.data(withJSONObject:[["name":"VIP 1","url":"/vip/fixture73/playlist.json"]])
                let key=SymmetricKey(data:Data(SHA256.hash(data:Data(("spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|"+url.path+"|fixture73").utf8))))
                let box=try AES.GCM.seal(plain,using:key);var data=box.combined!;if mode=="tampered"{data[data.count-1]^=1};reply(Data(data.base64EncodedString().utf8),type:"text/plain")
            }catch{json(["error":"Fixture encoding failed"],status:500)};return}
            json(["playlist":[["sources":[["file":"https://vip.1x2.space/fixture73/master.m3u8","type":"hls","label":"1080p"]]]]]);return
        }
        if url.host=="vip.1x2.space"{
            Self.state.lock.withLock{Self.state.vip+=1}
            if mode=="vip-refused"{json(["error":"Synthetic refusal"],status:403);return}
            if url.path.hasSuffix("part.ts"){
                if mode=="html-instead-of-ts"{reply(Data("<html>Not a video</html>".utf8),type:"text/html");return}
                do{reply(try Data(contentsOf:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("fullscreen70-HLS/part0.ts")),type:"text/html")}catch{json(["error":"Missing synthetic MPEG-TS"],status:500)};return
            }
            if url.path.hasSuffix("master.m3u8"){reply(Data("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nvariant.m3u8\n".utf8),type:"application/vnd.apple.mpegurl");return}
            let length=mode=="wrong-runtime" ? "8200":"5750.578"
            reply(Data(("#EXTM3U\n"+(mode=="encrypted" ? "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n":"")+"#EXT-X-TARGETDURATION:6000\n#EXTINF:"+length+",\npart.ts\n#EXT-X-ENDLIST\n").utf8),type:"application/vnd.apple.mpegurl");return
        }
        json(["error":"Unexpected fixture request"],status:500)
    }
    override func stopLoading(){}
}
@MainActor struct SourceFallbackChecks73:View {
    let live:Bool
    @State private var result="Checking selected-film fallback…"
    var body:some View{Text(result).padding().task{await check()}}
    private func check()async{
        var checks:[String:Bool]=[:],details:[String:Any]=[:]
        do{
            if live{
                let client=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:StandaloneService()),phone=PhonePlaybackModel()
                phone.player.isMuted=true;defer{phone.stop(client)}
                await phone.prepare(client,selection:.init(kind:"movie",contentID:1514026,season:nil,episode:nil),position:600)
                checks["NativeStandaloneBuddy2026ReadyThroughXPS"]=phone.ready && phone.title=="Buddy" && phone.sourceInfo?.selection?.contentID==1514026 && phone.sourceInfo?.provider=="2embed · XPS VIP"
                details["nativeTitle"]=phone.title;details["sourceProvider"]=phone.sourceInfo?.provider ?? "none";details["error"]=phone.error ?? "none"
                if phone.ready,let asset=phone.player.currentItem?.asset{
                    let duration=phone.player.currentItem?.duration.seconds ?? 0;details["nativeDurationSeconds"]=duration
                    checks["NativeDurationMatchesSelected2026Movie"]=duration.isFinite && abs(duration-5760)<300
                    _ = asset
                    let output=AVPlayerItemVideoOutput(pixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]);phone.player.currentItem?.add(output)
                    var buffer:CVPixelBuffer?
                    for _ in 0..<30{buffer=output.copyPixelBuffer(forItemTime:phone.player.currentTime(),itemTimeForDisplay:nil);if buffer != nil{break};try await Task.sleep(for:.milliseconds(200))}
                    guard let buffer else{throw RemoteFailure(message:"Native decoder did not produce a video frame within the check deadline.")}
                    let decoded=CIImage(cvPixelBuffer:buffer);guard let image=CIContext().createCGImage(decoded,from:decoded.extent) else{throw RemoteFailure(message:"The decoded frame could not be inspected.")}
                    let file=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("buddy73-native-frame.png");try UIImage(cgImage:image).pngData()?.write(to:file)
                    checks["ActualSelectedNativeVideoFrameDecoded"]=image.width>0 && image.height>0
                }
                phone.stop(client)
            }else{
                for mode in ["success","xps-offline","wrong-id","tampered","wrong-runtime","encrypted","swish-refused","vip-refused"]{
                    SourceFallbackProtocol73.reset(mode);let service=StandaloneService()
                    do{
                        let(title,sources)=try await service.resolve(kind:"movie",id:1514026,season:1,episode:1)
                        checks[mode+"ExpectedOutcome"]=mode=="success" && title=="Buddy" && sources.first?.provider=="2embed · XPS VIP" && sources.first?.url.host=="vip.1x2.space"
                        if mode=="success"{checks["WrongReleaseRejectionStillTriesExistingXPS"]=SourceFallbackProtocol73.counts.0>0;let body:[String:Any]=["operation":"prepare","selection":["kind":"movie","contentID":1514026]];let bytes=try await service.request("/remote/v1/media",query:[],body:try JSONSerialization.data(withJSONObject:body));let grant=(try JSONSerialization.jsonObject(with:bytes)) as? [String:Any] ?? [:];checks["GrantKeepsRequestedBuddy2026Identity"]=(grant["title"] as? String)=="Buddy" && ((grant["sourceInfo"] as? [String:Any])?["selection"] as? [String:Any])?["contentID"] as? Int==1514026}
                    }catch{
                        let message=error.localizedDescription
                        checks[mode+"ExpectedOutcome"]=mode != "success"
                        if !["swish-refused","vip-refused"].contains(mode){checks[mode+"ErrorNamesSelectedRelease"]=message.contains("Buddy (2026)") && !message.contains("Buddy 2024")}
                        if mode=="swish-refused"{checks["AccessRefusalDoesNotTryOtherProviders"]=SourceFallbackProtocol73.counts.0==0}
                        if mode=="wrong-id" || mode=="tampered"{checks[mode+"NoMediaSourceAccepted"]=SourceFallbackProtocol73.counts.1==0}
                    }
                }
                for (title,actual,expected,pass) in [("Crash",1996,2004,false),("The Thing",1982,2011,false),("Inception",2010,2010,true)]{
                    do{try StandaloneSwishPage.verifyIdentity(html:"<title>\(title) \(actual) 1080p WEBRip</title>",expectedTitles:[title],expectedYear:expected);checks[title+"SharedReleaseValidation"]=pass}catch{checks[title+"SharedReleaseValidation"] = !pass}
                }
                SourceFallbackProtocol73.reset("success");let service=StandaloneService()
                let(knownTitle,knownSources)=try await service.resolve(kind:"movie",id:27205,season:1,episode:1)
                checks["DistinctInception2010KeepsExistingVidemPath"]=knownTitle=="Inception" && knownSources.first?.url.host=="videm.xyz"
                for (mode,accepted) in [("success",true),("html-instead-of-ts",false)]{
                    SourceFallbackProtocol73.reset(mode);let service=StandaloneService()
                    func request(_ body:[String:Any])async throws->[String:Any]{let bytes=try await service.request("/remote/v1/media",query:[],body:try JSONSerialization.data(withJSONObject:body));return try JSONSerialization.jsonObject(with:bytes) as? [String:Any] ?? [:]}
                    let grant=try await request(["operation":"prepare","selection":["kind":"movie","contentID":1514026]]),handle=grant["handle"] as! String
                    do{
                        _ = try await request(["operation":"resource","handle":handle,"resourceID":"0"]);_ = try await request(["operation":"resource","handle":handle,"resourceID":"1"])
                        let segment=try await request(["operation":"resource","handle":handle,"resourceID":"2"])
                        checks[mode+"MIMEPacketValidation"]=accepted && segment["contentType"] as? String=="video/mp2t"
                    }catch{checks[mode+"MIMEPacketValidation"] = !accepted}
                }
            }
            result=checks.values.allSatisfy{$0} ? "Selected-film fallback checks passed":"A selected-film fallback check failed"
        }catch{checks["completedWithoutError"]=false;result=error.localizedDescription}
        let report:[String:Any]=["checks":checks,"details":details,"result":result,"physicalPlaybackCommands":0,"liveProviderRead":live]
        let name=live ? "source-fallback73-live.json":"source-fallback73.json",folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:folder.appendingPathComponent(name),options:.atomic)}
    }
}
#endif

#if DEBUG
@MainActor struct SourceParityChecks76:View{
    let live:Bool
    @State private var result="Checking original TV source parity…"
    var body:some View{Text(result).padding().task{await verify()}}
    private func verify()async{
        var checks:[String:Bool]=[:],details:[String:Any]=[:]
        do{
            if live{
                let client=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:StandaloneService()),phone=PhonePlaybackModel();phone.player.isMuted=true;defer{phone.stop(client)}
                await phone.prepare(client,selection:.init(kind:"tv",contentID:1399,season:1,episode:1),position:60)
                details["error"]=phone.error ?? "none";details["title"]=phone.title;details["provider"]=phone.sourceInfo?.provider ?? "none"
                checks["OriginalXPSRouteReadyForGameOfThronesS1E1"]=phone.ready && phone.sourceInfo?.selection?.id==PhonePlaybackSelection(kind:"tv",contentID:1399,season:1,episode:1).id && phone.sourceInfo?.provider=="2embed · XPS VIP"
                if phone.ready,let item=phone.player.currentItem{
                    let output=AVPlayerItemVideoOutput(pixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]);item.add(output);defer{item.remove(output)}
                    var decoded=false
                    for _ in 0..<40{
                        if let buffer=output.copyPixelBuffer(forItemTime:phone.player.currentTime(),itemTimeForDisplay:nil){let image=CIImage(cvPixelBuffer:buffer);if let cg=CIContext().createCGImage(image,from:image.extent),let png=UIImage(cgImage:cg).pngData(){let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? png.write(to:folder.appendingPathComponent("got76-live-frame.png"))};decoded=true;break};try await Task.sleep(for:.milliseconds(100))
                    }
                    checks["ActualEpisodeFrameDecoded"]=decoded;details["duration"]=item.duration.seconds.isFinite ? item.duration.seconds:0
                    details["qualities"]=phone.qualityChoices.map(\.label);checks["AdvertisedQualityChoicesPreserved"]=phone.qualityEnabled && phone.qualityChoices.count>=2
                    if let smaller=phone.qualityChoices.last{phone.selectQuality(smaller.id);checks["QualitySelectionAppliesWithoutNewLease"]=phone.currentSource=="0" && item.preferredMaximumResolution==smaller.size;phone.selectQuality("automatic");checks["AutomaticQualityStillSelectable"]=item.preferredMaximumResolution == .zero;phone.selectQuality("highest")}
                }
            }else{
                for (mode,allowed) in [("tv76-success",true),("tv76-wrong-data-episode",false),("tv76-wrong-config-episode",false),("tv76-encrypted",false),("tv76-live",false),("tv76-xps-refused",false)]{
                    SourceFallbackProtocol73.reset(mode);let service=StandaloneService()
                    do{let(_,sources)=try await service.resolveMultiEmbed(kind:"tv",id:1399,season:1,episode:1);checks[mode]=allowed && sources.count==1 && sources[0].url.host=="vip.1x2.space" && sources[0].provider=="2embed · XPS VIP"}
                    catch{checks[mode] = !allowed}
                    checks[mode+"NeverFetchesExternalVsrcCDN"]=SourceFallbackProtocol73.external76==0
                    if mode=="tv76-wrong-data-episode" || mode=="tv76-wrong-config-episode"{checks[mode+"StopsBeforeMediaRequest"]=SourceFallbackProtocol73.counts.1==0}
                    if mode=="tv76-xps-refused"{checks["RefusalDoesNotTryAnotherXPSRequest"]=SourceFallbackProtocol73.counts.0==1 && SourceFallbackProtocol73.counts.1==0}
                }
                for (season,episode,valid) in [(1,1,true),(1,2,false),(2,1,false)]{
                    do{_ = try StandaloneXPS.dataURL(html:"var dataUrl=\"/data/tv/1399/1/1?token=inert\";",contentID:1399,season:season,episode:episode);checks["ExactTupleS\(season)E\(episode)"]=valid}catch{checks["ExactTupleS\(season)E\(episode)"] = !valid}
                }
            }
        }catch{checks["completedWithoutError"]=false;details["error"]=error.localizedDescription}
        result=checks.values.allSatisfy{$0} ? "TV source parity verified":"TV source parity check failed"
        let report:[String:Any]=["checks":checks,"details":details,"live":live,"physicalPlaybackCommands":0,"result":result],folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:folder.appendingPathComponent(live ? "source-parity76-live.json":"source-parity76.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
final class RemoteFixtureProtocol77:URLProtocol,@unchecked Sendable{
    private let lock=NSLock();private var work:URLSessionDataTask?
    private let network:URLSession={let c=URLSessionConfiguration.ephemeral;c.httpCookieStorage=nil;c.urlCredentialStorage=nil;return URLSession(configuration:c)}()
    override class func canInit(with request:URLRequest)->Bool{request.url?.host=="remote77.local"}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){
        guard let url=request.url,var parts=URLComponents(url:url,resolvingAgainstBaseURL:false),url.path.hasPrefix("/remote/v1/") else{return}
        parts.scheme="http";parts.host="127.0.0.1";parts.port=47178
        var forward=request;forward.url=parts.url
        if forward.httpBody==nil,let stream=request.httpBodyStream{stream.open();defer{stream.close()};var data=Data(),buffer=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable{let n=stream.read(&buffer,maxLength:buffer.count);if n<=0{break};data.append(contentsOf:buffer.prefix(n))};forward.httpBodyStream=nil;forward.httpBody=data}
        let task=network.dataTask(with:forward){[weak self] data,response,error in guard let self else{return};if let error{self.client?.urlProtocol(self,didFailWithError:error);return};guard let response=response as? HTTPURLResponse,let mapped=HTTPURLResponse(url:url,statusCode:response.statusCode,httpVersion:nil,headerFields:["Content-Type":"application/json"]) else{return};self.client?.urlProtocol(self,didReceive:mapped,cacheStoragePolicy:.notAllowed);if let data{self.client?.urlProtocol(self,didLoad:data)};self.client?.urlProtocolDidFinishLoading(self)}
        lock.withLock{work=task};task.resume()
    }
    override func stopLoading(){lock.withLock{work?.cancel();work=nil}}
}
@MainActor struct RemotePhoneChecks77:View{
    @State private var result="Checking Mac-source iPhone preparation…"
    var body:some View{Text(result).padding().task{await verify()}}
    private func verify()async{
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[RemoteFixtureProtocol77.self];config.httpCookieStorage=nil;config.urlCredentialStorage=nil
        let network=URLSession(configuration:config);defer{network.invalidateAndCancel()}
        let client=RemoteClient(baseURL:URL(string:"https://remote77.local")!,token:"SYNTHETIC-REMOTE77",session:network)
        var attempts:[[String:Any]]=[]
        for selection in [PhonePlaybackSelection(kind:"anime",contentID:38000,season:1,episode:1),.init(kind:"movie",contentID:27205,season:nil,episode:nil),.init(kind:"tv",contentID:1396,season:1,episode:2)]{
            let phone=PhonePlaybackModel();phone.player.isMuted=true
            await phone.prepare(client,selection:selection,position:60)
            var row:[String:Any]=["kind":selection.kind,"contentID":selection.contentID,"ready":phone.ready,"error":phone.error ?? "none","identityMatches":phone.sourceInfo?.selection?.id==selection.id,"provider":phone.sourceInfo?.provider ?? "none","sourceCount":phone.sources.count]
            if phone.ready,let item=phone.player.currentItem{
                let output=AVPlayerItemVideoOutput(pixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]);item.add(output);var decoded=false
                for _ in 0..<40{if let buffer=output.copyPixelBuffer(forItemTime:phone.player.currentTime(),itemTimeForDisplay:nil){decoded=true;let image=CIImage(cvPixelBuffer:buffer);if let cg=CIContext().createCGImage(image,from:image.extent),let png=UIImage(cgImage:cg).pngData(){let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? png.write(to:folder.appendingPathComponent("remote77-\(selection.kind)-\(selection.contentID).png"))};break};try? await Task.sleep(for:.milliseconds(100))}
                row["decodedFrame"]=decoded;row["duration"]=item.duration.seconds.isFinite ? item.duration.seconds:0;item.remove(output)
            }
            phone.stop(client);attempts.append(row)
            let report:[String:Any]=["attempts":attempts,"allComplete":attempts.count==3,"backend":"production Remote modules and isolated actual Mac Next/proxy server","physicalPlaybackCommands":0]
            if let bytes=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? bytes.write(to:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("remote-phone77.json"),options:.atomic)}
        }
        result="Mac-source iPhone checks complete"
    }
}
#endif
