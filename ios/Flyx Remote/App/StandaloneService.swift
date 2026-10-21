import Foundation

struct StandaloneSource:Sendable {
    let url:URL
    let headers:[String:String]
    let format:String
    let provider:String
    let quality:String
    let language:String
    var cookieHost:String?=nil
    func requestHeaders(for target:URL)->[String:String]{var value=headers;if target.host != cookieHost{value.removeValue(forKey:"Cookie")};return value}
}
struct StandaloneMediaSession {
    let selection:[String:Int]
    let kind:String
    let title:String
    var sources:[StandaloneSource]
    var index=0
    var resources:[String:URL]=[:]
    var position:Double=0
    var paused=false
    var accessRefused=false
}
/// Native on-device service. Only Data crosses its actor boundary; no Mac endpoint or credential is used.
actor StandaloneService {
    static let shared=StandaloneService()
    let network:URLSession
    let boundedMedia:BoundedMediaHTTP
    let file:URL
    var watchlistSync:WatchlistSyncState
    var saved:[String:Any]
    var titles:[String:[String:Any]]=[:]
    var media:[String:StandaloneMediaSession]=[:]
    var progressLeases:[String:(String,Int)]=[:]
    var nextPages:[String:Int]=[:]
    var animeMappings:[Int:StandaloneAnimeMapping]=[:]
    var mangaChapters:[String:[String:Any]]=[:]
    var mangaAccess:[String:StandaloneMangaPages]=[:]
    var providerCookies:[String:[HTTPCookie]]=[:]
    var refusedHosts=Set<String>()
    var mediaFailures:[String:String]=[:]
    #if DEBUG
    var debugNetworkRequests=0
    var debugProviderTrackFields:[String]=[]
    var debugProviderIdentity=""
    #endif
    var homeCache:[String:(Data,Date)]=[:]
    var homeRowCache:[String:Data]=[:]
    var weebSeries:[String:WeebSeries]=[:]
    var mangaTags:[String:String]=[:]
    var catalogueCache:[String:([[String:Any]],Date)]=[:]
    let scopes=["catalog.read","playback.control","watchlist.write"]
    init() {
        let config=URLSessionConfiguration.ephemeral
        config.httpCookieStorage=nil;config.urlCredentialStorage=nil;config.timeoutIntervalForRequest=15;config.timeoutIntervalForResource=30
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("anime-routing75"){config.protocolClasses=[AnimeFixtureProtocol75.self]}
        if ProcessInfo.processInfo.arguments.contains("source-parity76"){config.protocolClasses=[SourceFallbackProtocol73.self]}
        if ProcessInfo.processInfo.arguments.contains("source-fallback73"){config.protocolClasses=[SourceFallbackProtocol73.self]}
        if ProcessInfo.processInfo.arguments.contains("playback-identity72"){config.protocolClasses=[IdentityFixtureProtocol72.self]}
        if ProcessInfo.processInfo.arguments.contains("--relay-synthetic62"){config.protocolClasses=[RelayFixtureProtocol62.self]}
        if ProcessInfo.processInfo.arguments.contains(where:{["fullscreen-lifecycle70","captions-controls71","captions-portrait71","captions-fullscreen71"].contains($0)}){config.protocolClasses=[FullscreenLocalAssetProtocol70.self]}
        #endif
        network=URLSession(configuration:config,delegate:StandaloneNoRedirects(),delegateQueue:nil)
        boundedMedia=BoundedMediaHTTP(protocolClasses:config.protocolClasses)
        file=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("standalone/library.json")
        saved=((try? Data(contentsOf:file)).flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any]) ?? ["watchlist":[],"progress":[:]]
        let legacy = (try? JSONSerialization.data(withJSONObject: saved["watchlist"] ?? []))
            .flatMap { try? JSONDecoder().decode([RemoteTitle].self, from: $0) } ?? []
        watchlistSync = (try? JSONSerialization.data(withJSONObject: saved["watchlistSync"] ?? [:]))
            .flatMap { try? JSONDecoder().decode(WatchlistSyncState.self, from: $0) } ?? WatchlistSyncState(items: legacy)
    }
    deinit{network.invalidateAndCancel();boundedMedia.invalidate()}
    func invalidateCatalogueCaches(){homeCache.removeAll();homeRowCache.removeAll();catalogueCache.removeAll();nextPages.removeAll()}
    func persist()throws {
        saved["watchlist"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(watchlistSync.current.items))
        saved["watchlistSync"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(watchlistSync))
        try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
        try JSONSerialization.data(withJSONObject:saved).write(to:file,options:.atomic)
    }
    func json(_ value:Any)throws->Data{try JSONSerialization.data(withJSONObject:value)}
    func request(_ path:String,query:[URLQueryItem],body:Data?)async throws->Data {
        try Task.checkCancellation()
        let q=Dictionary(query.map{($0.name,$0.value ?? "")},uniquingKeysWith:{$1})
        let b=(body.flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any]) ?? [:]
        switch path {
        case "/remote/v1/info":return try json(["protocolVersion":1,"name":"This iPhone","features":["catalog.home.v1","catalog.home.categories.v1","catalog.reviews.v1","catalog.minVotes","phone.direct.mp4","phone.direct.hls","player.progress.v1"]])
        case "/remote/v1/session":return try json(["deviceID":"standalone-iphone","scopes":scopes,"expiresAt":Double.greatestFiniteMagnitude])
        case "/remote/v1/catalog":
            let kind=q["kind"] ?? "movie",search=q["q"] ?? "",page=Int(q["page"] ?? "1") ?? 1
            let items=try await catalogue(kind:kind,query:search,page:page,filters:q),next=nextPages[catalogueKey(kind:kind,query:search,page:page,filters:q)] ?? 0
            return try json(["items":items,"nextPage":next>0 ? next as Any:NSNull()])
        case "/remote/v1/home":return try await home(category:q["category"] ?? "all",refresh:q["refresh"]=="1")
        case "/remote/v1/details":return try json(try await details(kind:q["kind"] ?? "movie",id:q["id"] ?? "",season:Int(q["season"] ?? "1") ?? 1))
        case "/remote/v1/reviews":return try json(try await reviews(q))
        case "/remote/v1/watchlist":
            if body != nil {
                let id=b["id"] as? String ?? "",kind=b["kind"] as? String ?? "movie",operation=b["operation"] as? String ?? ""
                guard ["add","remove"].contains(operation) else { throw RemoteFailure(message:"Invalid watchlist action.") }
                let item: RemoteTitle
                if let raw=b["item"],let data=try? JSONSerialization.data(withJSONObject:raw),let supplied=try? JSONDecoder().decode(RemoteTitle.self,from:data),supplied.id==id,supplied.kind==kind {item=supplied}
                else if let known=watchlistSync.current.items.first(where:{$0.id==id && $0.kind==kind}) {item=known}
                else {let raw=try await details(kind:kind,id:id,season:1);item=try JSONDecoder().decode(RemoteTitle.self,from:json(raw))}
                let previous=watchlistSync
                do{try watchlistSync.current.edit(item,add:operation=="add");try persist()}
                catch{watchlistSync=previous;throw error}
                return try json(["ok":true])
            }
            return try JSONEncoder().encode(WatchlistPage(items:watchlistSync.current.items))
        case "/remote/v1/media":
            do{return try json(try await mediaRequest(b))}catch{if let handle=b["handle"] as? String,b["operation"] as? String != "next-source",let failure=error as? RemoteFailure{mediaFailures[handle]=failure.message;if [403,451].contains(failure.status ?? 0),var session=media[handle]{session.accessRefused=true;media[handle]=session}};throw error}
        case "/remote/v1/manga/chapter":return try json(try await mangaChapter(b))
        case "/remote/v1/manga/image":return try await mangaImage(q)
        case "/remote/v1/progress":return try json(try progressRequest(b))
        case "/remote/v1/status":return try json(["state":"idle","position":0,"duration":0,"output":"phone","outputName":"This iPhone"])
        case "/remote/v1/downloads":return try json(["jobs":[]])
        default:throw RemoteFailure(message:"This action is available in Mac Remote mode.")
        }
    }
    func section(id:String,kind:String,title:String,subtitle:String,items:[[String:Any]])->[String:Any]{["id":id,"kind":kind,"title":title,"subtitle":subtitle,"source":"On this iPhone","ranked":false,"stale":false,"items":items.map{["id":kind+":"+String(describing:$0["id"] ?? ""),"title":$0]}]}
    func fetch(_ url:URL,headers:[String:String]=[:],body:[String:Any]?=nil,range:String?=nil,maxBytes:Int?=nil)async throws->(Data,HTTPURLResponse) {
        guard url.scheme=="https",url.user==nil,url.password==nil,let host=url.host,!host.isEmpty,!host.hasSuffix(".local"),host != "localhost",host != "127.0.0.1" else{throw RemoteFailure(message:"A secure public source address is required.")}
        guard !refusedHosts.contains(host) else{throw RemoteFailure(message:"The provider refused access (HTTP 403). Choose another source; no access challenge is bypassed.",status:403)}
        #if DEBUG
        debugNetworkRequests+=1
        #endif
        var req=URLRequest(url:url);req.setValue("Mozilla/5.0",forHTTPHeaderField:"User-Agent")
        for(k,v)in headers{req.setValue(v,forHTTPHeaderField:k)}
        if let body{req.httpMethod="POST";req.setValue("application/json",forHTTPHeaderField:"Content-Type");req.httpBody=try json(body)}
        if let range{req.setValue(range,forHTTPHeaderField:"Range")}
        let data:Data,response:URLResponse
        if let maxBytes{
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){await RelayTrace63.shared.event("bounded-fetch-begin",["hasCookie":String(req.value(forHTTPHeaderField:"Cookie") != nil)])}
            #endif
            do{let result=try await boundedMedia.data(for:req,limit:maxBytes);data=result.0;response=result.1}catch let failure as RemoteFailure{if [403,451].contains(failure.status ?? 0){refusedHosts.insert(host)};throw failure}
        }else{(data,response)=try await network.data(for:req)}
        try Task.checkCancellation()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--relay-compare63"),maxBytes != nil{await RelayTrace63.shared.event("bounded-fetch-end",["bytes":String(data.count),"status":String((response as? HTTPURLResponse)?.statusCode ?? 0)])}
        #endif
        guard let response=response as? HTTPURLResponse else{throw RemoteFailure(message:"The provider returned no HTTP response.")}
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--standalone-movie54"),!(200..<300).contains(response.statusCode){UIOnlyProtocol.probe(["movieUpstreamFailure":["host":host,"status":response.statusCode,"server":response.value(forHTTPHeaderField:"Server") ?? "","type":response.value(forHTTPHeaderField:"Content-Type") ?? "","blockedReason":response.value(forHTTPHeaderField:"X-Mitmproxy-Blocked-Reason") ?? ""]])}
        #endif
        guard (200..<300).contains(response.statusCode) else{if [403,451].contains(response.statusCode){refusedHosts.insert(host)};throw RemoteFailure(message:"The provider returned HTTP \(response.statusCode). \([403,451].contains(response.statusCode) ? "Access was refused; no challenge is bypassed.":"Try again later or choose another source.")",status:response.statusCode)}
        guard data.count<=32*1024*1024 else{throw RemoteFailure(message:"Source response exceeds the phone's size limit.")}
        return(data,response)
    }
    func fetchJSON(_ address:String,headers:[String:String]=[:],body:[String:Any]?=nil)async throws->[String:Any]{
        guard let url=URL(string:address) else{throw URLError(.badURL)}
        let(data,_)=try await fetch(url,headers:headers,body:body)
        guard let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw RemoteFailure(message:"The provider returned an invalid response.")};return value
    }
    func remember(_ items:[[String:Any]])->[[String:Any]]{for item in items{titles[(item["kind"] as? String ?? "")+":"+(item["id"] as? String ?? "")]=item};return items}
    func normalizeTMDB(_ d:[String:Any],kind:String)->[String:Any] {
        var out:[String:Any]=["id":String(describing:d["id"] ?? ""),"kind":kind,"title":d["title"] ?? d["name"] ?? "Untitled","overview":d["overview"] ?? ""]
        out["posterURL"]=(d["poster_path"] as? String).map{"https://image.tmdb.org/t/p/w500"+$0} ?? NSNull()
        out["backdropURL"]=(d["backdrop_path"] as? String).map{"https://image.tmdb.org/t/p/w780"+$0} ?? NSNull()
        out["rating"]=d["vote_average"];out["voteCount"]=d["vote_count"];out["releaseDate"]=d["release_date"] ?? d["first_air_date"]
        return out
    }
    func tmdb(_ path:String,query:[URLQueryItem]=[])async throws->[String:Any] {
        guard let credential=StandaloneCredentials.load() else{throw RemoteFailure(message:"Add your TMDB API key or API Read Access Token in Settings to browse Movies and TV.")}
        let data=try await TMDBAccess.load(path:path,query:[.init(name:"language",value:"en-US")]+query,credential:credential,session:network)
        guard let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw TMDBAccessError.invalidResponse}
        return value
    }
    func details(kind:String,id:String,season:Int)async throws->[String:Any] {
        if kind=="manga"{return try await mangaDetails(id)}
        if kind=="anime"{return try await animeDetails(id)}
        let data=try await tmdb("/\(kind)/\(id)",query:[.init(name:"append_to_response",value:"videos,credits")]);var d=normalizeTMDB(data,kind:kind)
        d["episodeCount"]=NSNull();d["seasons"]=[];d["metadata"]=[["label":"Source","value":"TMDB"]]
        if kind=="tv" {
            let seasons=data["seasons"] as? [[String:Any]] ?? [],selected=seasons.first(where:{$0["season_number"] as? Int==season})?["season_number"] as? Int ?? seasons.first?["season_number"] as? Int ?? 1
            let episodes=try await tmdb("/tv/\(id)/season/\(selected)")
            d["selectedSeason"]=selected;d["seasons"]=seasons.map{v->[String:Any] in let n=v["season_number"] as? Int ?? 0;return ["number":n,"episodes":n==selected ? (episodes["episodes"] as? [[String:Any]] ?? []).map{["number":$0["episode_number"] ?? 1,"title":$0["name"] ?? "Episode"]}:[]]}
        }
        if kind=="movie",let videos=data["videos"] as? [String:Any],let trailer=(videos["results"] as? [[String:Any]])?.first(where:{$0["site"] as? String=="YouTube" && $0["type"] as? String=="Trailer"}),let key=trailer["key"] as? String {d["trailer"]=["videoID":key,"title":trailer["name"] ?? "Trailer"]}
        titles[kind+":"+id]=d;return d
    }
    func reviews(_ q:[String:String])async throws->[String:Any] {
        let id=q["id"] ?? q["contentID"] ?? "",kind=q["kind"] ?? "movie"
        guard !id.hasPrefix("900000"),StandaloneCredentials.hasToken else{return ["items":[],"page":1,"nextPage":NSNull(),"total":0,"order":"tmdb"]}
        let d=try await tmdb("/\(kind)/\(id)/reviews",query:[.init(name:"page",value:q["page"] ?? "1")])
        let items=(d["results"] as? [[String:Any]] ?? []).map{v->[String:Any] in let a=v["author_details"] as? [String:Any] ?? [:];return ["id":v["id"] ?? "","author":v["author"] ?? "Audience member","text":v["content"] ?? "","rating":a["rating"] ?? NSNull(),"createdAt":v["created_at"] ?? NSNull(),"url":v["url"] ?? ""]}
        let page=d["page"] as? Int ?? 1,total=d["total_pages"] as? Int ?? 1
        return ["items":items,"page":page,"nextPage":page<total ? (page+1 as Any):NSNull(),"total":d["total_results"] ?? 0,"order":"tmdb"]
    }
    func resolve(kind:String,id:Int,season:Int,episode:Int)async throws->(String,[StandaloneSource]) {
        #if DEBUG
        if kind=="movie",[72,73].contains(id),ProcessInfo.processInfo.arguments.contains("playback-identity72"){
            if id==73,IdentityFixtureProtocol72.currentMode=="fail-blue"{try await Task.sleep(for:.milliseconds(350));throw RemoteFailure(message:"Synthetic blue title unavailable")}
            return (id==72 ? "Red title":"Blue title",[.init(url:URL(string:"https://identity72.invalid/"+(id==72 ? "red":"blue")+".mp4")!,headers:[:],format:"mp4",provider:"Local identity fixture",quality:"Synthetic",language:"")])
        }
        if kind=="movie",id==900000071,ProcessInfo.processInfo.arguments.contains(where:{["fullscreen-lifecycle70","captions-controls71","captions-portrait71","captions-fullscreen71"].contains($0)}){return ("Generated silent HLS check",[.init(url:URL(string:"https://fullscreen70.invalid/master.m3u8")!,headers:[:],format:"hls",provider:"Inert local HLS",quality:"Synthetic",language:"")])}
        if kind=="movie",id==900000070,ProcessInfo.processInfo.arguments.contains(where:{["fullscreen-lifecycle70","captions-controls71","captions-portrait71","captions-fullscreen71"].contains($0)}){return ("Generated silent fullscreen check",[.init(url:URL(string:"https://fullscreen70.invalid/silent.mp4")!,headers:[:],format:"mp4",provider:"Inert local asset",quality:"Synthetic",language:"")])}
        if kind=="movie",id==900000099 {return ("Apple HLS playback check",[.init(url:URL(string:"https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8")!,headers:[:],format:"hls",provider:"Apple public test stream",quality:"Adaptive",language:"")])}
        #endif
        if kind=="anime"{return try await resolveMappedAnime(id:id,episode:episode)}
        let(title,sources)=try await resolveMultiEmbed(kind:kind,id:id,season:season,episode:episode)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--standalone-fallback56"){
            let unavailable=StandaloneSource(url:URL(string:"https://fixture.invalid/unavailable.m3u8")!,headers:[:],format:"hls",provider:"Fixture 502 · no network",quality:"Synthetic",language:"")
            return(title,[unavailable]+Array(sources.prefix(1)))
        }
        #endif
        return(title,sources)
    }

    func grant(handle:String,session:StandaloneMediaSession)->[String:Any] {
        let source=session.sources[session.index]
        return ["handle":handle,"title":session.title,"position":session.position,"duration":0,"paused":session.paused,"format":source.format,"mode":"direct","currentSource":String(session.index),"sourceInfo":["origin":"provider","provider":source.provider,"quality":source.quality,"qualityBasis":"advertised","selection":["kind":session.kind,"contentID":session.selection["contentID"] ?? 0,"season":session.selection["season"] ?? 1,"episode":session.selection["episode"] ?? 1]],"sources":session.sources.enumerated().map{["id":String($0.offset),"provider":$0.element.provider,"quality":$0.element.quality,"language":$0.element.language,"format":$0.element.format]}]
    }
    func mediaRequest(_ body:[String:Any])async throws->[String:Any] {
        let operation=body["operation"] as? String ?? ""
        if operation=="prepare" {
            guard let selection=body["selection"] as? [String:Any],let kind=selection["kind"] as? String,["movie","tv","anime"].contains(kind),let id=selection["contentID"] as? Int,id>0 else{throw RemoteFailure(message:"Choose a title on this iPhone first.")}
            let season=selection["season"] as? Int ?? 1,episode=selection["episode"] as? Int ?? 1
            guard season>=0,episode>0 else{throw RemoteFailure(message:"Choose a valid season and episode.")}
            let(title,sources)=try await resolve(kind:kind,id:id,season:season,episode:episode)
            try Task.checkCancellation()
            let handle=UUID().uuidString
            var s=StandaloneMediaSession(selection:["contentID":id,"season":season,"episode":episode],kind:kind,title:title,sources:sources)
            s.position=body["position"] as? Double ?? 0;s.resources=["0":sources[0].url];media[handle]=s
            return grant(handle:handle,session:s)
        }
        guard let handle=body["handle"] as? String,var s=media[handle] else{throw RemoteFailure(message:"Reopen this title to refresh its standalone playback session.")}
        guard !s.accessRefused || ["close","cancel-prepare"].contains(operation) else{throw RemoteFailure(message:"The source refused access. Playback has stopped; another source will not be requested automatically.",status:403)}
        switch operation {
        case "cast-info":
            let source=s.sources[s.index]
            if source.format=="mp4",source.headers.isEmpty{return ["supported":true,"url":source.url.absoluteString,"contentType":"video/mp4","title":s.title]}
            #if DEBUG
            if source.url.host=="devstreaming-cdn.apple.com",source.headers.isEmpty{return ["supported":true,"url":source.url.absoluteString,"contentType":"application/vnd.apple.mpegurl","title":s.title]}
            #endif
            if source.format=="hls",["vidsrc.buzz","videm.xyz"].contains(source.url.host ?? ""){return ["supported":true,"relay":true,"sourceID":String(s.index),"contentType":"application/vnd.apple.mpegurl","title":s.title]}
            #if DEBUG
            if source.format=="hls",source.url.host=="relay-fixture.invalid"{return ["supported":true,"relay":true,"sourceID":String(s.index),"contentType":"application/vnd.apple.mpegurl","title":s.title]}
            #endif
            return ["supported":false,"title":s.title,"reason":"TV playback is not available for this source yet. It can keep playing on your iPhone."]
        case "chunk":
            let offset=(body["offset"] as? NSNumber)?.int64Value ?? 0,length=body["length"] as? Int ?? 0
            guard offset>=0,(1...1048576).contains(length) else{throw RemoteFailure(message:"Invalid video range.")}
            let source=s.sources[s.index],(data,response)=try await fetch(source.url,headers:source.requestHeaders(for:source.url),range:"bytes=\(offset)-\(offset+Int64(length)-1)")
            guard response.statusCode==206,let contentRange=response.value(forHTTPHeaderField:"Content-Range"),let total=Int64(contentRange.split(separator:"/").last ?? ""),data.count<=length,!data.isEmpty else{throw RemoteFailure(message:"This source does not support safe seeking on iPhone.")}
            return ["bytes":data.base64EncodedString(),"offset":offset,"total":total]
        case "resource","cast-resource":
            guard let id=body["resourceID"] as? String,let url=s.resources[id] else{throw RemoteFailure(message:"The HLS resource is no longer available.")}
            #if DEBUG
            if url.host=="fixture.invalid"{let refused=s.sources[s.index].provider=="Fixture 403";UIOnlyProtocol.probe(["source56InjectedFailure":refused ? 403:502]);throw RemoteFailure(message:refused ? "Synthetic access refusal":"Synthetic source outage",status:refused ? 403:502)}
            #endif
            let source=s.sources[s.index],isPlaylist=id=="0" || url.pathExtension.lowercased()=="m3u8",casting=operation=="cast-resource"
            #if DEBUG
            if casting,ProcessInfo.processInfo.arguments.contains("--relay-compare63"),url.host != source.url.host{await RelayTrace63.shared.event("selected-CDN",["host":url.host ?? "none","sourceIDMatches":String(body["sourceID"] as? String==String(s.index))])}
            #endif
            let sameOrigin=url.host==source.url.host && (url.port ?? 443)==(source.url.port ?? 443)
            // These exact CDNs were advertised by the permitted source and decoded by
            // the phone path. It remains limited to registered resources in this lease.
            let selectedCDN=["vidsrc.buzz","videm.xyz"].contains(source.url.host ?? "") && ["p16-ad-site-sign-sg.tiktokcdn.com","p19-ad-site-sign-sg.tiktokcdn.com"].contains(url.host ?? "") && (url.port ?? 443)==443
            if casting{guard body["sourceID"] as? String==String(s.index),sameOrigin || selectedCDN else{throw RemoteFailure(message:"This TV source changed or uses an unsupported media host. Return to iPhone and try again.")}}
            var upstreamHeaders=source.requestHeaders(for:url)
            if casting,!sameOrigin{upstreamHeaders=upstreamHeaders.filter{["user-agent","referer","accept"].contains($0.key.lowercased())}}
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){await RelayTrace63.shared.event("resource-fetch",["mode":casting ? "relay":"phone","id":id])}
            #endif
            let(data,response)=try await fetch(url,headers:upstreamHeaders,range:casting || isPlaylist ? nil:(body["range"] as? String),maxBytes:casting ? 8_388_608:nil)
            if casting,response.statusCode != 200{throw RemoteFailure(message:"This source did not return a complete bounded media resource.")}
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--standalone-movie54"),(Int(id) ?? 999)<32 {
                let prefix=String(data:data.prefix(200),encoding:.utf8) ?? ""
                UIOnlyProtocol.probe(["movieResource"+id:["status":response.statusCode,"type":response.value(forHTTPHeaderField:"Content-Type") ?? "","bytes":data.count,"range":body["range"] as? String ?? "none","contentRange":response.value(forHTTPHeaderField:"Content-Range") ?? "none","playlistFlag":isPlaylist,"m3u8":prefix.hasPrefix("#EXTM3U"),"signature":data.prefix(8).map{String(format:"%02x",$0)}.joined(),"ts188":data.count>188 && data[0]==0x47 && data[188]==0x47]])
            }
            #endif
            guard data.count<=8*1024*1024 else{throw RemoteFailure(message:"The HLS segment exceeds the phone's size limit.")}
            guard let latest=media[handle],latest.index==s.index else{throw RemoteFailure(message:"This playback source has changed.")};s=latest
            var bytes=data,type=response.value(forHTTPHeaderField:"Content-Type")?.components(separatedBy:";").first?.trimmingCharacters(in:.whitespaces).lowercased() ?? "application/octet-stream"
            if let text=String(data:data,encoding:.utf8),text.trimmingCharacters(in:.whitespacesAndNewlines).hasPrefix("#EXTM3U") {
                guard !text.contains("#EXT-X-KEY:"),!text.contains("#EXT-X-SESSION-KEY:"),!text.contains("#EXTINF") || text.contains("#EXT-X-ENDLIST") else{throw RemoteFailure(message:"Encrypted or live HLS is not supported by this standalone player.")}
                // Full-length films can exceed 4,096 segments. Keep a bounded index,
                // and reuse known URLs before applying capacity to new resources.
                var registered=Dictionary(s.resources.map{($0.value,$0.key)},uniquingKeysWith:{$1})
                func register(_ raw:String)throws->String {
                    guard let target=URL(string:raw,relativeTo:url)?.absoluteURL,target.scheme=="https",target.user==nil,target.password==nil else{throw RemoteFailure(message:"Invalid HLS resource address.")}
                    if let existing=registered[target]{return "flyx-resource://"+existing}
                    guard s.resources.count<16_384 else{throw RemoteFailure(message:"This source contains too many HLS resources for this iPhone.")}
                    let key=String(s.resources.count);s.resources[key]=target;registered[target]=key;return "flyx-resource://"+key
                }
                var lines:[String]=[]
                let regex=try NSRegularExpression(pattern:"URI=\"([^\"]+)\"")
                for line in text.components(separatedBy:.newlines) {
                    if line.isEmpty{lines.append(line);continue}
                    if !line.hasPrefix("#"){lines.append(try register(line.trimmingCharacters(in:.whitespaces)));continue}
                    var rewritten=line
                    for match in regex.matches(in:line,range:NSRange(line.startIndex...,in:line)).reversed(){guard let range=Range(match.range(at:1),in:rewritten) else{continue};let replacement=try register(String(rewritten[range]));rewritten.replaceSubrange(range,with:replacement)}
                    lines.append(rewritten)
                }
                bytes=Data(lines.joined(separator:"\n").utf8);type="application/vnd.apple.mpegurl";media[handle]=s
            }
            // Some existing XPS CDNs label clear MPEG-TS as text/html. Validate the
            // complete bounded packet structure before correcting that MIME type.
            if type != "application/vnd.apple.mpegurl",let transport=StandaloneSegment.transportStream(bytes){bytes=transport;type="video/mp2t"}
            if type=="text/html"{throw RemoteFailure(message:"This source returned a web page instead of playable video.")}
            if type.hasPrefix("image/"){
                guard response.statusCode==200,let transport=StandaloneSegment.transportStream(bytes) else{throw RemoteFailure(message:"This source returned image-wrapped segments without a supported clear MPEG transport stream.")}
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--standalone-movie54"){UIOnlyProtocol.probe(["movieUnwrapped"+id:["inputBytes":bytes.count,"outputBytes":transport.count,"outputType":"video/mp2t"]])}
                #endif
                bytes=transport;type="video/mp2t"
            }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){await RelayTrace63.shared.event("resource-ready",["mode":casting ? "relay":"phone","id":id,"type":type,"bytes":String(bytes.count)])}
            #endif
            if type=="binary/octet-stream"{type="application/octet-stream"}
            if casting,type != "application/vnd.apple.mpegurl",let raw=body["range"] as? String{
                let bounds=try RelayByteRange(raw).bounds(count:bytes.count),total=bytes.count;bytes=bytes.subdata(in:bounds)
                return ["bytes":bytes.base64EncodedString(),"contentType":type,"status":206,"contentRange":"bytes \(bounds.lowerBound)-\(bounds.upperBound-1)/\(total)"]
            }
            let returnedRange:Any = casting ? NSNull():(response.value(forHTTPHeaderField:"Content-Range").map{$0 as Any} ?? NSNull())
            return ["bytes":bytes.base64EncodedString(),"contentType":type,"status":response.statusCode,"contentRange":returnedRange]
        case "next-source","select-source":
            let index=operation=="next-source" ? s.index+1:Int(body["sourceID"] as? String ?? "") ?? -1
            guard s.sources.indices.contains(index) else{throw RemoteFailure(message:mediaFailures[handle].map{"No other compatible source is available. "+$0} ?? "No other standalone source is available. Try another title or retry later.")}
            s.index=index;s.position=body["position"] as? Double ?? s.position;s.paused=body["paused"] as? Bool ?? false;s.resources=["0":s.sources[index].url];media[handle]=s
            return grant(handle:handle,session:s)
        case "phone-ready":return ["ok":true,"status":["state":"prepared","position":s.position,"duration":0],"transfer":["position":s.position,"paused":s.paused]]
        case "phone-started":return ["ok":true]
        case "close","cancel-prepare":media.removeValue(forKey:handle);mediaFailures.removeValue(forKey:handle);progressLeases=progressLeases.filter{$0.value.0 != handle};return ["ok":true]
        default:throw RemoteFailure(message:"This output is available in Mac Remote mode.")
        }
    }
    func progressRequest(_ b:[String:Any])throws->[String:Any] {
        let operation=b["operation"] as? String ?? ""
        var progress=saved["progress"] as? [String:Any] ?? [:]
        if operation=="read",let s=b["selection"] as? [String:Any] {let key=(s["kind"] as? String ?? "")+":"+String(describing:s["contentID"] ?? "");return ["entry":progress[key] ?? NSNull()]}
        if operation=="begin",let handle=b["handle"] as? String,media[handle] != nil {let id=UUID().uuidString;progressLeases[id]=(handle,0);return ["sessionID":id]}
        guard operation=="update",let id=b["sessionID"] as? String,let(handle,previous)=progressLeases[id],let s=media[handle],let sequence=b["sequence"] as? Int,sequence>previous else{throw RemoteFailure(message:"The local progress session has expired.")}
        let key=s.kind+":"+String(s.selection["contentID"] ?? 0)
        progress[key]=["kind":s.kind,"contentID":s.selection["contentID"] ?? 0,"season":s.selection["season"] ?? 1,"episode":s.selection["episode"] ?? 1,"position":b["position"] ?? 0,"duration":b["duration"] ?? 0,"completed":b["ended"] ?? false,"lastWatchedAt":Date().timeIntervalSince1970*1000]
        saved["progress"]=progress;progressLeases[id]=(handle,sequence);try persist();return ["ok":true]
    }
}

private final class StandaloneNoRedirects:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping @Sendable (URLRequest?)->Void){completionHandler(nil)}
}
