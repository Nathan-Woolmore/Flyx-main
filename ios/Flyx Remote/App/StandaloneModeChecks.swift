#if DEBUG
import SwiftUI

@MainActor struct StandaloneModeChecksView:View{
    @State private var complete=false
    var body:some View{VStack(spacing:16){Text("Standalone candidate checks").font(.title2.bold());Text(complete ? "Mode checks complete":"Checking app modes…")}.task{await verify();complete=true}}
    private func verify()async{
        let routingKey="flyx.routingPreference.v1",previousRouting=UserDefaults.standard.string(forKey:routingKey)
        defer{if let previousRouting{UserDefaults.standard.set(previousRouting,forKey:routingKey)}else{UserDefaults.standard.removeObject(forKey:routingKey)}}
        let key="flyx.preferredApplicationMode",previous=UserDefaults.standard.string(forKey:key)
        defer{if let previous{UserDefaults.standard.set(previous,forKey:key)}else{UserDefaults.standard.removeObject(forKey:key)}}
        let model=ApplicationModeModel();model.mode = .remote;model.playback.status=PlaybackStatus(state:"playing",position:12,duration:60,title:"Inert status",output:"mac")
        let oldPlayback=model.playback,epoch=model.generation;model.choose(.standalone)
        var result:[String:Any]=["staleOutputCleared":model.mode == .standalone && model.playback.status==nil && model.playback !== oldPlayback && model.generation>epoch]
        model.playback.phone.busy=true;model.choose(.remote);result["preparingBlocksSwitch"]=model.mode == .standalone
        model.playback.phone.busy=false;model.playback.phone.ready=true;model.choose(.remote);result["readyPhoneBlocksSwitch"]=model.mode == .standalone
        model.playback.phone.ready=false;model.playback.busy=true;model.choose(.remote);result["busyBlocksSwitch"]=model.mode == .standalone
        model.playback.busy=false;model.choose(.remote);result["remoteModeSelectable"]=model.mode == .remote
        model.choose(.standalone);result["standaloneModeSelectable"]=model.mode == .standalone
        let oldOwner=model.playback;oldOwner.phone.ready=true;model.choose(.remote)
        result["activeSwitchRequestsConfirmation"]=model.requestedMode == .remote && model.mode == .standalone
        model.choose(.remote,endingPlayback:true);result["confirmedSwitchReplacesOwner"]=model.mode == .remote && model.playback !== oldOwner
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[DelayedModeProtocol.self]
        let connection=RemoteSession();connection.address="https://inert-unavailable.local";connection.checkFixture=RemoteClient(baseURL:URL(string:connection.address)!,session:URLSession(configuration:config))
        model.connection=connection
        let work=Task{await connection.check()};try? await Task.sleep(for:.milliseconds(50))
        model.choose(.standalone);await work.value
        result["lateConnectionReplyIgnored"]=connection.phase == .disconnected && connection.client==nil && model.mode == .standalone
        for phase in [RemoteSession.Phase.checking,.waitingForApproval,.unavailable("Timeout"),.unavailable("Credentials unavailable")]{
            connection.phase=phase;model.connection=connection;model.choose(.remote);model.connection=connection;model.choose(.standalone)
        }
        result["unavailableStatesSwitchBothWays"]=model.mode == .standalone
        result["persistedRemoteRestores"]=true;model.choose(.remote);result["persistedRemoteRestores"]=ApplicationModeModel().mode == .remote
        model.choose(.standalone);result["persistedStandaloneRestores"]=ApplicationModeModel().mode == .standalone
        let automatic=ApplicationModeModel();automatic.mode = .standalone;automatic.useAutomatic()
        let autoConfig=URLSessionConfiguration.ephemeral;autoConfig.protocolClasses=[AutomaticModeProtocol67.self]
        let autoSession=URLSession(configuration:autoConfig);defer{autoSession.invalidateAndCancel()}
        automatic.automaticFixture = .init(endpoint:"https://fixture.local",certificatePin:String(repeating:"a",count:64),token:String(repeating:"SYNTHETIC",count:8),deviceID:"fixture-device",scopes:["catalog.read"],pendingApproval:false)
        automatic.automaticFixtureClient=RemoteClient(baseURL:URL(string:"https://fixture.local")!,session:autoSession)
        await automatic.connectAutomatically();result["autoAdoptsAvailableMacBeforeInteraction"]=automatic.mode == .remote && automatic.automaticClient != nil
        automatic.mode = .standalone;automatic.automaticClient=nil
        let tapped=Task{await automatic.connectAutomatically()};try? await Task.sleep(for:.milliseconds(20));automatic.recordInteraction();await tapped.value
        result["autoKeepsCurrentScreenAfterInteraction"]=automatic.mode == .standalone
        automatic.lastInteraction = .distantPast
        let playing=Task{await automatic.connectAutomatically()};try? await Task.sleep(for:.milliseconds(20));automatic.playback.phone.ready=true;await playing.value
        result["autoDoesNotSwitchDuringPlayback"]=automatic.mode == .standalone
        automatic.playback.phone.ready=false
        automatic.homeAtRoot=false
        await automatic.connectAutomatically();result["autoKeepsDetailNavigation"]=automatic.mode == .standalone
        automatic.homeAtRoot=true;automatic.lastInteraction = .distantPast
        let owner=automatic.playback,display=automatic.displayGeneration
        await automatic.connectAutomatically();result["autoReconnectsWhenHomeBecomesIdle"]=automatic.mode == .remote && automatic.playback === owner && automatic.displayGeneration==display
        automatic.automaticFixtureClient=RemoteClient(baseURL:URL(string:"https://unavailable.fixture.local")!,session:autoSession)
        await automatic.connectAutomatically();result["autoFallsBackOfflineWithoutReplacingHome"]=automatic.mode == .standalone && automatic.playback === owner && automatic.displayGeneration==display
        automatic.automaticFixtureClient=RemoteClient(baseURL:URL(string:"https://fixture.local")!,session:autoSession)
        automatic.reconnectAfter = .distantPast
        await automatic.connectAutomatically();result["autoPrefersMacAgainAfterItReturns"]=automatic.mode == .remote
        automatic.mode = .standalone;automatic.automaticClient=nil
        let manual=Task{await automatic.connectAutomatically()};try? await Task.sleep(for:.milliseconds(20));automatic.choose(.standalone);await manual.value
        result["manualSelectionInvalidatesLateAutoReply"]=automatic.mode == .standalone && automatic.routingPreference=="standalone"
        let offline=ApplicationModeModel();offline.useAutomatic();offline.mode = .remote;offline.automaticClient=automatic.automaticFixtureClient;offline.activeClient=offline.automaticClient
        offline.automaticFixture=automatic.automaticFixture;offline.automaticFixtureClient=RemoteClient(baseURL:URL(string:"https://unavailable.fixture.local")!,session:autoSession)
        offline.homeAtRoot=false;offline.playback.selectedTab="browse";offline.lastInteraction=Date();offline.settings=true
        offline.playback.status=PlaybackStatus(state:"playing",position:123,duration:1200,title:"Retained TV title",output:"tv")
        let held=offline.playback,heldDisplay=offline.displayGeneration,heldClient=offline.automaticClient
        await offline.connectAutomatically()
        result["unavailableMacFallsBackFromDetailWhileInteracting"]=offline.mode == .standalone && offline.playback === held && offline.displayGeneration==heldDisplay && !offline.homeAtRoot && offline.playback.selectedTab=="browse"
        result["TVTitlePositionAndOwnerRetainedWithoutPhonePlayback"]=held.status?.title=="Retained TV title" && held.status?.position==123 && held.status?.output=="tv" && !held.phoneActive && held.phone.player.currentItem==nil && held.controlClient === heldClient
        offline.automaticFixtureClient=automatic.automaticFixtureClient;offline.reconnectAfter = .distantPast
        await offline.connectAutomatically();result["returningMacDoesNotReplaceTVOrDetail"]=offline.mode == .standalone
        let timeout=ApplicationModeModel();timeout.useAutomatic();timeout.mode = .remote;timeout.automaticClient=automatic.automaticFixtureClient;timeout.automaticFixture=automatic.automaticFixture;timeout.automaticFixtureClient=RemoteClient(baseURL:URL(string:"https://hanging.fixture.local")!,session:autoSession);timeout.probeTimeout = .milliseconds(150)
        let began=ContinuousClock.now;await timeout.connectAutomatically();result["hangingMacHasBoundedDeadline"]=timeout.mode == .standalone && began.duration(to:.now) < .seconds(1)
        timeout.mode = .remote;timeout.choose(.remote);await timeout.connectAutomatically();result["manualRemoteDoesNotFallBack"]=timeout.mode == .remote && timeout.routingPreference=="remote"
        let browser=CatalogBrowser();browser.select("anime");browser.search("Jujutsu");let request=browser.request
        browser.useSource(URL(string:"https://old.fixture.local")!)
        let oldPage=Task{await browser.load{_,_ in try await Task.sleep(for:.milliseconds(400));return CatalogPage(items:[RemoteTitle(id:"1",kind:"anime",title:"Stale Mac row",overview:"",posterURL:nil)],nextPage:nil)}}
        try? await Task.sleep(for:.milliseconds(25));browser.useSource(URL(string:"https://standalone.invalid")!)
        await browser.load{_,_ in CatalogPage(items:[RemoteTitle(id:"40748",kind:"anime",title:"Standalone row",overview:"",posterURL:nil)],nextPage:nil)}
        await oldPage.value
        result["sourceChangeRetainsSearchAndRejectsOldMacCatalogue"]=browser.request==request && browser.snapshot.items.map(\.id)==["40748"]
        result["externalNetworkRequests"]=0;result["inertDelayedReplies"]=1;result["pairingStoreReadOrWritten"]=false
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        if let data=try? JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("standalone-mode56.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
private final class DelayedModeProtocol:URLProtocol,@unchecked Sendable{
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){DispatchQueue.global().asyncAfter(deadline:.now()+0.3){[self] in client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:Data("{\"protocolVersion\":1,\"name\":\"Inert Mac\"}".utf8));client?.urlProtocolDidFinishLoading(self)}}
    override func stopLoading(){}
}
#endif

#if DEBUG
private final class AutomaticModeProtocol67:URLProtocol,@unchecked Sendable{
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){
        if request.url?.host=="hanging.fixture.local"{return}
        if request.url?.host=="unavailable.fixture.local"{client?.urlProtocol(self,didFailWithError:URLError(.cannotConnectToHost));return}
        DispatchQueue.global().asyncAfter(deadline:.now()+0.1){[self] in client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:Data("{\"deviceID\":\"fixture-device\",\"scopes\":[\"catalog.read\"],\"expiresAt\":9999999999999}".utf8));client?.urlProtocolDidFinishLoading(self)}}
    override func stopLoading(){}
}
#endif

#if DEBUG
import SwiftUI
@preconcurrency import AVFoundation
import CoreImage

/// Inert responses exercise edition identity, source ordering and the actual native decoder.
final class AnimeFixtureProtocol75:URLProtocol,@unchecked Sendable{
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){
        guard let url=request.url else{return}
        let q=Dictionary((URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems ?? []).map{($0.name,$0.value ?? "")},uniquingKeysWith:{$1})
        var body=request.httpBody ?? Data()
        if body.isEmpty,let stream=request.httpBodyStream{stream.open();defer{stream.close()};var buffer=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable{let count=stream.read(&buffer,maxLength:buffer.count);if count<=0{break};body.append(contentsOf:buffer.prefix(count))}}
        let payload=(try? JSONSerialization.jsonObject(with:body)) as? [String:Any] ?? [:],vars=payload["variables"] as? [String:Any] ?? [:]
        let mal=vars["id"] as? Int ?? vars["malId"] as? Int ?? 0
        var object:[String:Any]=[:]
        switch url.host ?? ""{
        case "graphql.anilist.co":
            object=["data":["Media":["idMal":mal,"title":["english":"Same display title"],"format":"TV","episodes":mal==16498 ? 25:mal==38000 ? 26:24,"startDate":["year":2020]]]]
        case "graphql.animex.one":
            object=["data":["anime":["id":"edition-\(mal)","malId":mal==999999 ? 40748:mal,"titleEnglish":"Alias is deliberately different","episodeCount":90]]]
        case "pp.animex.one":
            if url.path.hasSuffix("servers") {object=["subProviders":[["id":"sora"],["id":"miku"],["id":"uwu"],["id":"yuki"]],"dubProviders":[["id":"uwu"]]]}
            else {
                let stem="https://anime75.invalid/\(q["id"] ?? "")/\(q["epNum"] ?? "")/\(q["providerId"] ?? "")/\(q["type"] ?? "")"
                object=["sources":[["url":stem+"/1080/silent.mp4","quality":"1080p","type":"video/mp4"],["url":stem+"/720/silent.mp4","quality":"720p","type":"video/mp4"]],"headers":["Referer":"https://anime75.invalid/","Origin":"https://anime75.invalid","Cookie":"must-not-forward"]]
            }
        case "anime75.invalid":
            guard request.value(forHTTPHeaderField:"Referer")=="https://anime75.invalid/",request.value(forHTTPHeaderField:"Cookie")==nil else{client?.urlProtocol(self,didFailWithError:URLError(.userAuthenticationRequired));return}
            let file=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("anime75.mp4")
            guard let bytes=try? Data(contentsOf:file) else{client?.urlProtocol(self,didFailWithError:URLError(.fileDoesNotExist));return}
            let range=request.value(forHTTPHeaderField:"Range") ?? "bytes=0-1048575"
            let parts=range.replacingOccurrences(of:"bytes=",with:"").split(separator:"-")
            let lower=Int(parts.first ?? "0") ?? 0,upper=min(bytes.count-1,Int(parts.last ?? "1048575") ?? 1048575)
            guard lower<=upper else{client?.urlProtocol(self,didFailWithError:URLError(.badServerResponse));return}
            reply(bytes.subdata(in:lower..<(upper+1)),url:url,status:206,headers:["Content-Type":"video/mp4","Content-Range":"bytes \(lower)-\(upper)/\(bytes.count)"]);return
        default:client?.urlProtocol(self,didFailWithError:URLError(.unsupportedURL));return
        }
        reply(try! JSONSerialization.data(withJSONObject:object),url:url,status:200,headers:["Content-Type":"application/json"])
    }
    private func reply(_ data:Data,url:URL,status:Int,headers:[String:String]){client?.urlProtocol(self,didReceive:HTTPURLResponse(url:url,statusCode:status,httpVersion:nil,headerFields:headers)!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)}
    override func stopLoading(){}
}
@MainActor struct AnimeRoutingChecks75:View{
    let live:Bool
    @State private var result="Checking anime edition routing…"
    var body:some View{Text(result).padding().task{await verify()}}
    private func verify()async{
        let service=StandaloneService(),client=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:service)
        var checks:[String:Bool]=[:],attempts:[[String:Any]]=[]
        for mal in [40748,16498,38000]{
            do{
                let details=try await client.details(RemoteTitle(id:String(mal),kind:"anime",title:"Edition check",overview:"",posterURL:nil))
                checks["\(mal)ExactEditionWithoutTVmaze"]=details.playbackUnavailable==nil
                if !live{
                    let(_,sources)=try await service.resolveMappedAnime(id:mal,episode:1)
                    checks["\(mal)Episode1StaysInEdition"]=sources.count==6 && sources.allSatisfy{$0.url.path.contains("/edition-\(mal)/1/")}
                    checks["\(mal)SubDubQualitiesRetained"]=sources.map(\.language)==["sub","sub","sub","sub","dub","dub"] && sources.map(\.quality)==["1080p","720p","1080p","720p","1080p","720p"] && sources[0].provider=="AnimeX · uwu"
                    checks["\(mal)HeadersRetainedWithoutCookies"]=sources.allSatisfy{$0.headers["Referer"]=="https://anime75.invalid/" && $0.headers["Cookie"]==nil}
                }
                let phone=PhonePlaybackModel();phone.player.isMuted=true
                await phone.prepare(client,selection:.init(kind:"anime",contentID:mal,season:1,episode:1),position:live ? 60:0)
                attempts.append(["kind":"anime","id":mal,"title":phone.title,"ready":phone.ready,"error":phone.error ?? "none","selectedID":phone.sourceInfo?.selection?.contentID ?? 0,"duration":phone.player.currentItem?.duration.seconds.isFinite==true ? phone.player.currentItem!.duration.seconds:0])
                if !live{checks["\(mal)NativeDecoderReadyForSelectedEdition"]=phone.ready && phone.sourceInfo?.selection?.contentID==mal}
                if phone.ready,let item=phone.player.currentItem{
                    let output=AVPlayerItemVideoOutput(pixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]);item.add(output)
                    var decoded=false
                    for _ in 0..<30{
                        if let buffer=output.copyPixelBuffer(forItemTime:phone.player.currentTime(),itemTimeForDisplay:nil){
                            decoded=true
                            if live{let image=CIImage(cvPixelBuffer:buffer);if let cg=CIContext().createCGImage(image,from:image.extent),let png=UIImage(cgImage:cg).pngData(){let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? png.write(to:folder.appendingPathComponent("anime75-\(mal)-frame.png"))}}
                            break
                        }
                        try? await Task.sleep(for:.milliseconds(100))
                    }
                    attempts[attempts.count-1]["decodedVideoFrame"]=decoded
                    if !live{checks["\(mal)DecodedVideoFrame"]=decoded}
                    item.remove(output)
                }
                phone.stop(client)
            }catch{attempts.append(["id":mal,"error":error.localizedDescription]);checks["\(mal)MetadataResolved"]=false}
        }
        if !live{
            do{let bad=try await client.details(RemoteTitle(id:"999999",kind:"anime",title:"Mismatch check",overview:"",posterURL:nil));checks["DifferentMALResponseRejected"]=bad.playbackUnavailable != nil}catch{checks["DifferentMALResponseRejected"]=true}
            do{_ = try await service.resolveMappedAnime(id:40748,episode:25);checks["CannotSpillIntoNextSeason"]=false}catch{checks["CannotSpillIntoNextSeason"]=true}
            let first=StandaloneService(),second=StandaloneService(),firstClient=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:first),secondClient=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:second),phone=PhonePlaybackModel()
            phone.player.isMuted=true
            await phone.prepare(firstClient,selection:.init(kind:"anime",contentID:40748,season:1,episode:1),position:0)
            await phone.prepare(secondClient,selection:.init(kind:"anime",contentID:38000,season:1,episode:1),position:0)
            for _ in 0..<20{if await first.debugLeaseCount75()==0{break};try? await Task.sleep(for:.milliseconds(50))}
            let oldCount=await first.debugLeaseCount75(),newCount=await second.debugLeaseCount75()
            checks["SourceChangeClosesOnlyOriginalServiceLease"]=phone.ready && oldCount==0 && newCount==1 && phone.sourceInfo?.selection?.contentID==38000
            phone.stop(secondClient)
            checks["PlainShiroURLPreserved"]=StandaloneAnimeSource.url("https://example.invalid/master.m3u8",provider:"shiro")?.lastPathComponent=="master.m3u8"
        }else{
            for selection in [PhonePlaybackSelection(kind:"movie",contentID:27205,season:nil,episode:nil),.init(kind:"tv",contentID:1399,season:1,episode:1),.init(kind:"tv",contentID:1396,season:1,episode:2)]{
                let phone=PhonePlaybackModel();phone.player.isMuted=true
                await phone.prepare(client,selection:selection,position:60)
                attempts.append(["kind":selection.kind,"id":selection.contentID,"ready":phone.ready,"error":phone.error ?? "none","selectedID":phone.sourceInfo?.selection?.contentID ?? 0]);phone.stop(client)
            }
        }
        result=checks.values.allSatisfy{$0} ? "Edition checks completed":"An edition check failed"
        let report:[String:Any]=["checks":checks,"attempts":attempts,"live":live,"physicalPlaybackCommands":0,"result":result]
        let folder=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:folder.appendingPathComponent(live ? "anime-routing75-live.json":"anime-routing75.json"),options:.atomic)}
    }
}
#endif

#if DEBUG
extension StandaloneService{func debugLeaseCount75()->Int{media.count}}
#endif
