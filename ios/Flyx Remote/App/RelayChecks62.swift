#if DEBUG
import SwiftUI
@preconcurrency import AVKit
@preconcurrency import GoogleCast

@MainActor struct RelayChecks62:View{
    @State private var player=AVPlayer()
    @State private var message="Checking selected-media relay…"
    private var real:Bool{ProcessInfo.processInfo.arguments.contains("--relay-provider62")}
    var body:some View{VStack(spacing:20){PhoneVideoSurface(player:player).frame(height:230);Text(message).multilineTextAlignment(.center);Text("Relay decoder check. No TV discovery or Cast session.").font(.footnote).foregroundStyle(.secondary)}.padding().task{await verify()}}
    private func verify()async{
        var result:[String:Any]=["mode":real ? "known permitted movie provider":"private generated synthetic HLS","sdkInitializedBefore":GCKCastContext.isSharedInstanceInitialized(),"actualPrivateLANBindTested":false,"loopbackBoundSurrogate":true,"hardwareDiscovery":false]
        let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        func record(){try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);if let data=try? JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:root.appendingPathComponent("relay-check62.json"),options:.atomic)}}
        let began=Date()
        func phase(_ name:String){result["phase"]=name;result["elapsedSeconds"]=Date().timeIntervalSince(began);record()}
        phase("starting")
        let service=StandaloneService(),client=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,scopes:["catalog.read","playback.control"],standalone:service)
        var relay:SelectedMediaRelay?
        defer{relay?.stop()}
        do{
            let binding=try PrivateLANBinding.choose(receiver:"192.168.20.22",candidates:[("utun0","192.168.20.10","255.255.255.0"),("en0","192.168.20.10","255.255.255.0")]);result["receiverPeerRestricted"]=SelectedMediaRelay.acceptsPeer("192.168.20.22",expected:"192.168.20.22") && !SelectedMediaRelay.acceptsPeer("192.168.20.23",expected:"192.168.20.22")
            result["privateInterfaceSelection"]=binding.interface=="en0" && binding.address != "0.0.0.0"
            var rejected=0
            for receiver in ["127.0.0.1","8.8.8.8","169.254.1.2","::1","192.168.99.10"]{do{_ = try PrivateLANBinding.choose(receiver:receiver,candidates:[("en0","192.168.20.10","255.255.255.0")])}catch{rejected+=1}}
            result["unusableNetworkRejected"]=rejected==5
            let handle:String
            if real{
                phase("resolve-selected-provider")
                let grant:PhoneMediaGrant=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"prepare",selection:.init(kind:"movie",contentID:120467,season:nil,episode:nil))));handle=grant.handle;result["resolvedTitle"]=grant.title;phase("selected-stream-resolved")
            }else{let raw=try await service.debugRelayLease62();handle=(try JSONSerialization.jsonObject(with:raw) as! [String:Any])["handle"] as! String}
            if real,!ProcessInfo.processInfo.arguments.contains("--relay-skip-direct63"){
                phase("direct-phone-proxy-start")
                let direct=try LoopbackHLS(client:client,handle:handle);let directURL=try await direct.start()
                let directAsset=AVURLAsset(url:directURL,options:[AVURLAssetHTTPCookiesKey:direct.cookies])
                phase("direct-phone-isPlayable")
                let cancel=Task{try? await Task.sleep(for:.seconds(18));if !Task.isCancelled{directAsset.cancelLoading()}}
                let playable=try await directAsset.load(.isPlayable);cancel.cancel();result["directPhonePlayable"]=playable
                let directItem=AVPlayerItem(asset:directAsset);player.isMuted=true;player.volume=0;player.replaceCurrentItem(with:directItem);player.play()
                phase("direct-phone-decoding")
                for _ in 0..<60{if player.currentTime().seconds>1.5{break};if directItem.status == .failed{break};try await Task.sleep(for:.milliseconds(250))}
                result["directPhoneTimeAdvances"]=player.currentTime().seconds>1.5;result["directPhoneWidth"]=directItem.presentationSize.width;result["directPhoneHeight"]=directItem.presentationSize.height
                player.pause();player.replaceCurrentItem(with:nil);direct.stop();phase("direct-phone-finished")
            }
            let plan:StandaloneCastPlan=try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"cast-info",handle:handle)));result["sourceEligibleForRelay"]=plan.supported && plan.requiresRelay && plan.url==nil
            let server=try SelectedMediaRelay(testClient:client,handle:handle,sourceID:"0");relay=server;let url=try await server.start();phase("relay-listener-started")
            let cfg=URLSessionConfiguration.ephemeral;cfg.httpCookieStorage=nil;cfg.timeoutIntervalForRequest=4;let http=URLSession(configuration:cfg)
            func get(_ url:URL,method:String="GET",headers:[String:String]=[:])async throws->(Data,HTTPURLResponse){var request=URLRequest(url:url);request.httpMethod=method;for(k,v)in headers{request.setValue(v,forHTTPHeaderField:k)};let(data,response)=try await http.data(for:request);return(data,response as! HTTPURLResponse)}
            phase("relay-master-fetch")
            let (master,response)=try await get(url);phase("relay-master-received");result["masterHTTP200"]=response.statusCode==200
            let text=String(decoding:master,as:UTF8.self),base=url.deletingLastPathComponent()
            result["noUpstreamOrCookieExport"] = !text.contains("relay-fixture.invalid") && !text.contains("fixture=inert") && !text.contains("vidsrc.buzz") && !text.contains("videm.xyz")
            let lines=text.components(separatedBy:.newlines),video=lines.first(where:{!$0.isEmpty && !$0.hasPrefix("#")}).flatMap(URL.init(string:))
            guard let video else{throw RemoteFailure(message:"No rewritten video playlist was available.")}
            let cors=try await get(url,method:"OPTIONS",headers:["Origin":"https://www.gstatic.com","Access-Control-Request-Method":"GET","Access-Control-Request-Headers":"Range"])
            result["privateNetworkCORS"]=cors.1.value(forHTTPHeaderField:"Access-Control-Allow-Private-Network")=="true"
            result["receiverCORS"]=cors.1.statusCode==204 && cors.1.value(forHTTPHeaderField:"Access-Control-Allow-Origin")=="https://www.gstatic.com"
            let evil=try await get(url,headers:["Origin":"https://untrusted.invalid"]);result["untrustedOriginRejected"]=evil.1.statusCode==403
            let wrong=base.deletingLastPathComponent().appendingPathComponent(String(repeating:"0",count:64)).appendingPathComponent("0")
            result["wrongTokenRejected"]=(try await get(wrong)).1.statusCode==401
            result["arbitraryURLQueryRejected"]=(try await get(URL(string:url.absoluteString+"?url=https://untrusted.invalid/")!)).1.statusCode==401
            phase("relay-child-fetch")
            let children=try await get(video);phase("relay-child-received");let childText=String(decoding:children.0,as:UTF8.self)
            result["nestedPlaylistRewritten"]=childText.hasPrefix("#EXTM3U") && !childText.contains("flyx-resource://")
            guard let segment=childText.components(separatedBy:.newlines).first(where:{!$0.isEmpty && !$0.hasPrefix("#")}).flatMap(URL.init(string:)) else{throw RemoteFailure(message:"No rewritten segment was available.")}
            if !real{
                let range=try await get(segment,headers:["Range":"bytes=0-187"]);result["normalizedRange"]=range.1.statusCode==206 && range.0.count==188 && range.0.first==0x47 && range.1.value(forHTTPHeaderField:"Content-Range")?.hasPrefix("bytes 0-187/")==true
                let suffix=try await get(segment,headers:["Range":"bytes=-188"]);result["suffixRange"]=suffix.1.statusCode==206 && suffix.0.count==188 && suffix.0.first==0x47
                let head=try await get(segment,method:"HEAD");result["headNoBody"]=head.1.statusCode==200 && head.0.isEmpty && (Int(head.1.value(forHTTPHeaderField:"Content-Length") ?? "0") ?? 0)>0
                result["multiRangeRejected"]=(try await get(segment,headers:["Range":"bytes=0-1,4-5"])).1.statusCode==416
                let before=await service.debugNetworkRequests;_ = try await get(base.appendingPathComponent("1"));result["crossOriginBlockedBeforeFetch"]=await service.debugNetworkRequests==before
                let oversized=try await get(base.appendingPathComponent("2"));result["oversizeResourceRejected"]=oversized.1.statusCode==502
                let regex=try NSRegularExpression(pattern:"URI=\"([^\"]+)\"")
                if let match=regex.firstMatch(in:text,range:NSRange(text.startIndex...,in:text)),let r=Range(match.range(at:1),in:text),let subtitles=URL(string:String(text[r])){let playlist=try await get(subtitles);let vtt=String(decoding:playlist.0,as:UTF8.self).components(separatedBy:.newlines).first(where:{!$0.isEmpty && !$0.hasPrefix("#")}).flatMap(URL.init(string:));if let vtt{let captions=try await get(vtt);result["subtitleRewriteAndMIME"]=captions.1.value(forHTTPHeaderField:"Content-Type")=="text/vtt" && String(decoding:captions.0,as:UTF8.self).hasPrefix("WEBVTT")}}
            }
            phase("relay-isPlayable")
            player.isMuted=true;player.volume=0;let asset=AVURLAsset(url:url);let loadingDeadline=Task{try? await Task.sleep(for:.seconds(18));if !Task.isCancelled{asset.cancelLoading()}}
            let playable=try await asset.load(.isPlayable);loadingDeadline.cancel();guard playable else{throw RemoteFailure(message:"The relayed source is not natively playable.")}
            phase("relay-decoding")
            let item=AVPlayerItem(asset:asset);player.replaceCurrentItem(with:item);player.play()
            for _ in 0..<60{if player.currentTime().seconds>1.5{break};if item.status == .failed{throw RemoteFailure(message:"Relay decoder failed.")};try await Task.sleep(for:.milliseconds(250))}
            result["itemStatus"]=item.status.rawValue;result["timeControl"]=player.timeControlStatus.rawValue;result["waitingReason"]=player.reasonForWaitingToPlay?.rawValue ?? "none"
            result["playerErrorCode"]=(item.error as NSError?)?.code ?? 0
            result["playerErrors"]=(item.errorLog()?.events ?? []).suffix(4).map{["status":$0.errorStatusCode,"domain":$0.errorDomain,"comment":($0.errorComment ?? "").replacingOccurrences(of:"https?://[^\\s\"<>]+",with:"[resource]",options:.regularExpression)] as [String:Any]}
            phase("relay-decoder-observed")
            let first=player.currentTime().seconds;try await Task.sleep(for:.seconds(1));result["nativeTimeAdvances"]=first>1 && player.currentTime().seconds>first+0.4
            player.pause();let paused=player.currentTime().seconds;try await Task.sleep(for:.milliseconds(300));result["pauseHeld"]=abs(player.currentTime().seconds-paused)<0.25
            phase("relay-seeking")
            let seekDeadline=Task{try? await Task.sleep(for:.seconds(8));if !Task.isCancelled{item.cancelPendingSeeks()}}
            let target=real ? 20.0:5.0;let sought=await player.seek(to:CMTime(seconds:target,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero);seekDeadline.cancel();player.play();try await Task.sleep(for:.seconds(1.2))
            result["seekAndResume"]=sought && player.currentTime().seconds>target+0.4;result["decodedWidth"]=item.presentationSize.width;result["decodedHeight"]=item.presentationSize.height;result["muted"]=player.isMuted && player.volume==0
            player.pause();result["sdkInitializedAfter"]=GCKCastContext.isSharedInstanceInitialized();message="Relay decode and security checks complete. No TV session."
            let priorSleep=UIApplication.shared.isIdleTimerDisabled
            let cast=StandaloneCastModel();let ticket=cast.inertRelay62(server,url:url)
            cast.acceptStatus(contentID:url.absoluteString,position:5,duration:12,paused:true,ticket:ticket)
            result["activeRelayPreventsAutoSleep"]=UIApplication.shared.isIdleTimerDisabled
            cast.applicationBackgrounded();result["screenSleepRestored"]=UIApplication.shared.isIdleTimerDisabled==priorSleep;result["backgroundStopsRelay"] = !cast.active && !cast.connecting
            try await Task.sleep(for:.milliseconds(200));do{_ = try await get(url);result["stoppedTokenInvalidated"]=false}catch{result["stoppedTokenInvalidated"]=true}
            if !real{
                let expiring=try SelectedMediaRelay(testClient:client,handle:handle,sourceID:"0",idleLimit:0.1);let expiredURL=try await expiring.start();try await Task.sleep(for:.milliseconds(1300));do{_ = try await get(expiredURL);result["idleExpiryClosesListener"]=false}catch{result["idleExpiryClosesListener"]=true};expiring.stop()
            }
            result["sdkInitializedAfter"]=GCKCastContext.isSharedInstanceInitialized();phase("complete")
        }catch{result["failedPhase"]=result["phase"];result["error"]=(error as? RemoteFailure)?.message ?? "Relay test failed before completion.";result["errorDomain"]=(error as NSError).domain;result["errorCode"]=(error as NSError).code;message=result["error"] as? String ?? "Relay test incomplete";record()}
    }
}
#endif

#if DEBUG
actor RelayTrace63{
    static let shared=RelayTrace63()
    private var events:[[String:String]]=[]
    func event(_ name:String,_ values:[String:String]=[:]){
        var entry=values;entry["event"]=name;entry["time"]=String(Date().timeIntervalSince1970);events.append(entry);if events.count>160{events.removeFirst(events.count-160)}
        let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        if let data=try? JSONSerialization.data(withJSONObject:events,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:root.appendingPathComponent("relay-trace63.json"),options:.atomic)}
    }
}
#endif
