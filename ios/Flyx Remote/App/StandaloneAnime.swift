import Foundation

/// MAL identifies an anime edition/season, unlike TVmaze's whole-show identity.
struct StandaloneAnimeMapping:Sendable {
    let malID:Int;let providerID:String;let title:String;let episodeCount:Int
}
enum StandaloneAnimeSource {
    static let priority=["uwu","kiwi","miku","beep","mimi","mochi","vee","neko","shiro"]
    static func providers(_ rows:[[String:Any]])->[String]{
        rows.compactMap{$0["id"] as? String}.enumerated().filter{!["yuki","sora"].contains($0.element)}.sorted{
            let left=priority.firstIndex(of:$0.element) ?? Int.max,right=priority.firstIndex(of:$1.element) ?? Int.max
            return left==right ? $0.offset<$1.offset:left<right
        }.prefix(2).map(\.element)
    }
    static func url(_ raw:String,provider:String)->URL?{
        var address=raw
        if provider=="shiro",let last=raw.split(separator:"/").last,last.count>=8,last.count.isMultiple(of:2),last.allSatisfy({$0.isHexDigit}){
            let chars=Array(last);var bytes:[UInt8]=[]
            for i in stride(from:0,to:chars.count,by:2){guard let byte=UInt8(String(chars[i...i+1]),radix:16) else{return nil};bytes.append(byte ^ 137)}
            if let decoded=String(bytes:bytes,encoding:.utf8),decoded.hasPrefix("https://"){address=decoded+"&origin=https://kem.clvd.xyz/"}
        }
        guard let value=URL(string:address),value.scheme=="https",value.host != nil,value.user==nil,value.password==nil else{return nil}
        return value
    }
}
extension StandaloneService{
    func mapAnime(_ value:[String:Any],id:Int)async throws->StandaloneAnimeMapping{
        if let cached=animeMappings[id]{return cached}
        // The original upstream extractor resolves the selected MAL ID directly.
        // Never replace it with a similarly named show, IMDb match or another season.
        let reply=try await fetchJSON("https://graphql.animex.one/graphql",body:["query":"query($malId:Int){anime(malId:$malId){id malId titleEnglish titleRomaji episodeCount}}","variables":["malId":id]])
        guard let anime=(reply["data"] as? [String:Any])?["anime"] as? [String:Any],anime["malId"] as? Int==id,let internalID=anime["id"] as? String,!internalID.isEmpty else{throw RemoteFailure(message:"The anime provider has no matching MAL edition for this title.")}
        let names=value["title"] as? [String:Any] ?? [:]
        let title=names["english"] as? String ?? names["romaji"] as? String ?? anime["titleEnglish"] as? String ?? anime["titleRomaji"] as? String ?? "Anime"
        let mapping=StandaloneAnimeMapping(malID:id,providerID:internalID,title:title,episodeCount:value["episodes"] as? Int ?? anime["episodeCount"] as? Int ?? 0)
        animeMappings[id]=mapping;return mapping
    }
    private func animeREST(_ path:String,id:String,episode:Int,language:String?=nil,provider:String?=nil)async throws->[String:Any]{
        var url=URLComponents(string:"https://pp.animex.one/rest/api/"+path)!
        var query=[URLQueryItem(name:"id",value:id),.init(name:"epNum",value:String(episode))]
        if let language{query.append(.init(name:"type",value:language))};if let provider{query.append(.init(name:"providerId",value:provider))};url.queryItems=query
        return try await fetchJSON(url.url!.absoluteString,headers:["Accept":"application/json"])
    }
    func resolveMappedAnime(id:Int,episode:Int)async throws->(String,[StandaloneSource]){
        if animeMappings[id]==nil{_ = try await animeDetails(String(id))}
        guard let mapping=animeMappings[id],mapping.malID==id,episode>0,mapping.episodeCount==0 || episode<=mapping.episodeCount else{throw RemoteFailure(message:"Choose an available episode of this anime edition.")}
        let servers=try await animeREST("servers",id:mapping.providerID,episode:episode)
        var sources:[StandaloneSource]=[],seen=Set<String>()
        for language in ["sub","dub"]{
            if language=="dub",!sources.isEmpty{try await Task.sleep(for:.milliseconds(300))}
            for provider in StandaloneAnimeSource.providers(servers[language+"Providers"] as? [[String:Any]] ?? []){
                do{
                    let result=try await animeREST("sources",id:mapping.providerID,episode:episode,language:language,provider:provider)
                    let supplied=result["headers"] as? [String:String] ?? [:]
                    let headers=supplied.filter{["referer","origin"].contains($0.key.lowercased())}
                    for row in result["sources"] as? [[String:Any]] ?? []{
                        guard let raw=row["url"] as? String,let url=StandaloneAnimeSource.url(raw,provider:provider),seen.insert(url.absoluteString).inserted else{continue}
                        let hls=["video/mpegurl","application/vnd.apple.mpegurl","application/x-mpegurl"].contains((row["type"] as? String ?? "").lowercased()) || url.absoluteString.contains(".m3u8")
                        sources.append(.init(url:url,headers:headers,format:hls ? "hls":"mp4",provider:"AnimeX · \(provider)",quality:row["quality"] as? String ?? "Auto",language:language))
                    }
                }catch is CancellationError{throw CancellationError()}catch let failure as RemoteFailure where [403,451].contains(failure.status ?? 0){throw failure}catch{continue}
            }
        }
        try Task.checkCancellation()
        guard !sources.isEmpty else{throw RemoteFailure(message:"The anime provider has no playable source for this episode. Try again later.")}
        return(mapping.title,sources)
    }
}
