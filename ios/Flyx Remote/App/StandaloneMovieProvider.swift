import Foundation

extension StandaloneService {
    /// Ordinary request chain already used by the Mac's MultiEmbed adapter.
    /// It follows only the advertised default player and first source. A refusal ends the request.
    func resolveMultiEmbed(kind:String,id:Int,season:Int,episode:Int,imdbID:String?=nil,titleOverride:String?=nil)async throws->(String,[StandaloneSource]){
        let agent="FlyxStandalone/1.0",origin="https://www.2embed.cc"
        let metadata=imdbID != nil ? ["title":titleOverride ?? "Anime"]:try await fetchJSON("https://api.2embed.cc/\(kind)?tmdb_id=\(id)",headers:["User-Agent":agent])
        let title=titleOverride ?? metadata["title"] as? String ?? metadata["name"] as? String ?? "Movie"
        if imdbID==nil{
            let returned=(metadata["tmdb_id"] as? NSNumber)?.intValue ?? Int(metadata["tmdb_id"] as? String ?? "")
            guard returned==id else{throw RemoteFailure(message:"The provider returned a different catalogue identity. Playback was not started.")}
        }
        let path:String
        if kind=="tv"{path="/embedtv/\(imdbID ?? String(id))&s=\(season)&e=\(episode)"}
        else{let imdb=metadata["imdb_id"] as? String ?? "";guard imdb.range(of:"^tt[0-9]{5,12}$",options:.regularExpression) != nil else{throw RemoteFailure(message:"This provider did not identify the selected movie.")};path="/embed/"+imdb}
        let embed=URL(string:origin+path)!, (html,_)=try await fetch(embed,headers:["User-Agent":agent,"Referer":origin+"/"])
        let player: URL
        do { player = try StandaloneEmbedPlayer.resolve(html: String(decoding: html, as: UTF8.self), pageURL: embed) }
        catch StandaloneEmbedPlayer.Failure.missing { throw RemoteFailure(message: "The provider did not return its player. Please try again later.") }
        catch { throw RemoteFailure(message: "This provider's default player is not supported on iPhone.") }
        if player.host == "streamsrcs.2embed.cc" {
            guard kind == "movie" else { throw RemoteFailure(message: "This provider did not return the selected episode's player.") }
            let known=titles[kind+":"+String(id)]
            let yearValues=[known?["releaseDate"] as? String,metadata["release_date"] as? String,(metadata["year"] as? String) ?? (metadata["year"] as? NSNumber)?.stringValue]
            let expectedYear=yearValues.compactMap{$0}.compactMap{Int($0.prefix(4))}.first(where:{(1800...2099).contains($0)})
            guard expectedYear != nil else{throw RemoteFailure(message:title+"'s release year could not be verified. No video was started.")}
            let expectedTitles=[known?["title"] as? String,title,metadata["original_title"] as? String].compactMap{$0}.filter{!$0.isEmpty}
            let selectedTitle=known?["title"] as? String ?? title
            let selectedLabel=expectedYear.map{selectedTitle+" (\($0))"} ?? selectedTitle
            do{return (selectedTitle,[try await resolveSwish(wrapper:player,expectedTitles:expectedTitles,expectedYear:expectedYear)])}
            catch is StandaloneMovieIdentityFailure{
                // Rejecting an unrelated release must still permit an existing, identity-bound alternative.
                do{
                    let runtime=(metadata["runtime"] as? NSNumber)?.intValue ?? Int(metadata["runtime"] as? String ?? "")
                    guard let runtime,let expectedYear,expectedYear>1800,let imdb=metadata["imdb_id"] as? String else{throw StandaloneMovieIdentityFailure.unidentified}
                    return (selectedTitle,[try await resolveXPSMovie(id:id,imdb:imdb,runtime:runtime)])
                }catch is CancellationError{throw CancellationError()}
                catch let failure as RemoteFailure where [401,403,429,451].contains(failure.status ?? 0){throw RemoteFailure(message:selectedLabel+": "+failure.message,status:failure.status)}
                catch{throw RemoteFailure(message:selectedLabel+" is unavailable from the iPhone sources checked. A different release was rejected; no video was started.")}
            }
        }
        guard let host = player.host else { throw RemoteFailure(message: "The provider returned an invalid player address.") }
        let sessionID=UUID().uuidString;providerCookies[sessionID]=[];defer{providerCookies.removeValue(forKey:sessionID)}
        func read(_ url:URL)async throws->Data{try await providerRead(url,host:host,sessionID:sessionID,referer:player.absoluteString)}
        let page=String(decoding:try await read(player),as:UTF8.self),configPattern=try NSRegularExpression(pattern:"var Q\\s*=\\s*(\\{[^\\n]+?\\});")
        guard let m=configPattern.firstMatch(in:page,range:NSRange(page.startIndex...,in:page)),let r=Range(m.range(at:1),in:page),let config=try JSONSerialization.jsonObject(with:Data(page[r].utf8)) as? [String:Any],let token=config["t"] as? String else{throw RemoteFailure(message:"This provider's player response has changed.")}
        if kind=="tv"{
            func number(_ value:Any?)->Int?{(value as? NSNumber)?.intValue ?? Int(value as? String ?? "")}
            guard config["type"] as? String=="tv",number(config["s"])==season,number(config["e"])==episode else{throw RemoteFailure(message:"The provider returned a different episode. Playback was not started.")}
        }
        let base="https://"+host,api=base+(host=="vidsrc.buzz" ? "/pl":"")+"/api.php"
        func address(_ query:[URLQueryItem])->URL{var c=URLComponents(string:api)!;c.queryItems=query;return c.url!}
        var servers=(config["ssr"] as? [String:Any])?["servers"] as? [[String:Any]] ?? []
        if servers.isEmpty {
            let data=try await read(address([.init(name:"a",value:"sources"),.init(name:"type",value:config["type"] as? String ?? kind),.init(name:"id",value:String(describing:config["id"] ?? "")),.init(name:"s",value:String(describing:config["s"] ?? 0)),.init(name:"e",value:String(describing:config["e"] ?? 0)),.init(name:"t",value:token)]))
            servers=(try JSONSerialization.jsonObject(with:data) as? [String:Any])?["servers"] as? [[String:Any]] ?? []
        }
        guard let first=servers.first,let ref=first["ref"] as? String else{throw RemoteFailure(message:"This provider has no advertised source for the selected title.")}
        let data=try await read(address([.init(name:"a",value:"play"),.init(name:"ref",value:ref),.init(name:"t",value:token)]))
        guard let source=try JSONSerialization.jsonObject(with:data) as? [String:Any],let raw=source["url"] as? String,let url=URL(string:raw,relativeTo:URL(string:base)!)?.absoluteURL,url.scheme=="https",url.user==nil,url.password==nil,source["type"] as? String=="hls" else{throw RemoteFailure(message:"This provider did not return a supported clear HLS source.")}
        if url.host != host{
            // The upstream Mac resolver prefers this existing XPS route for TV.
            // Never send the player's cookies to an external Vsrc CDN or bypass its refusal.
            guard kind=="tv",imdbID==nil else{throw RemoteFailure(message:"The provider advertised HLS on an unsupported external media host.")}
            return(title,[try await resolveXPS(id:id,season:season,episode:episode)])
        }
        #if DEBUG
        debugProviderTrackFields=source.keys.filter{["subtitles","tracks","captions"].contains($0.lowercased())}.sorted()
        debugProviderIdentity="\(config["id"] ?? "") · S\(config["s"] ?? "") E\(config["e"] ?? "")"
        #endif
        var headers=["User-Agent":agent,"Referer":base+"/"]
        let scoped=(providerCookies[sessionID] ?? []).filter{($0.domain==host || $0.domain=="."+host) && url.path.hasPrefix($0.path)}
        for(k,v)in HTTPCookie.requestHeaderFields(with:scoped){headers[k]=v}
        return(title,[.init(url:url,headers:headers,format:"hls",provider:"2embed · "+(first["name"] as? String ?? "Default"),quality:"Auto",language:"",cookieHost:host)])
    }
    private func resolveSwish(wrapper:URL,expectedTitles:[String],expectedYear:Int?) async throws -> StandaloneSource {
        let player = try StandaloneSwishPage.playerURL(wrapper: wrapper)
        let sessionID = UUID().uuidString
        providerCookies[sessionID] = []
        defer { providerCookies.removeValue(forKey: sessionID) }
        let html = try await providerRead(player, host: "2vcdn.skin", sessionID: sessionID, referer: wrapper.absoluteString)
        let page=String(decoding:html,as:UTF8.self)
        try StandaloneSwishPage.verifyIdentity(html:page,expectedTitles:expectedTitles,expectedYear:expectedYear)
        let url = try StandaloneSwishPage.source(html:page,player:player)
        var headers = ["User-Agent": "FlyxStandalone/1.0", "Referer": "https://2vcdn.skin/"]
        let scoped = (providerCookies[sessionID] ?? []).filter { ($0.domain == "2vcdn.skin" || $0.domain == ".2vcdn.skin") && url.path.hasPrefix($0.path) }
        for (key, value) in HTTPCookie.requestHeaderFields(with: scoped) { headers[key] = value }
        return .init(url: url, headers: headers, format: "hls", provider: "2embed · Swish", quality: "Auto", language: "", cookieHost: "2vcdn.skin")
    }

    private func resolveXPSMovie(id:Int,imdb:String,runtime:Int)async throws->StandaloneSource{
        try await resolveXPS(id:id,imdb:imdb,runtime:runtime)
    }
    private func resolveXPS(id:Int,imdb:String?=nil,runtime:Int?=nil,season:Int?=nil,episode:Int?=nil)async throws->StandaloneSource{
        let player:URL
        if let season,let episode{
            guard id>0,season>=0,episode>0 else{throw StandaloneMovieIdentityFailure.unidentified}
            player=URL(string:"https://play.xpass.top/e/tv/\(id)/\(season)/\(episode)")!
        }else{
            guard let imdb,imdb.range(of:"^tt[0-9]{5,12}$",options:.regularExpression) != nil else{throw StandaloneMovieIdentityFailure.unidentified}
            player=URL(string:"https://play.xpass.top/e/movie/"+imdb)!
        }
        let sessionID=UUID().uuidString
        providerCookies[sessionID]=[];defer{providerCookies.removeValue(forKey:sessionID)}
        func read(_ url:URL)async throws->Data{try await providerRead(url,host:"play.xpass.top",sessionID:sessionID,referer:player.absoluteString)}
        let page=String(decoding:try await providerRead(player,host:"play.xpass.top",sessionID:sessionID,referer:"https://streamsrcs.2embed.cc/"),as:UTF8.self)
        let address=try StandaloneXPS.dataURL(html:page,contentID:id,season:season,episode:episode)
        let backups=try StandaloneXPS.backups(try await read(address),url:address)
        // This is the Mac resolver's preferred VIP path, already checked for native clear HLS.
        guard let vip=backups.first(where:{($0["name"] as? String ?? "").uppercased().hasPrefix("VIP")}),let raw=vip["url"] as? String,let playlistURL=URL(string:raw,relativeTo:player)?.absoluteURL,playlistURL.scheme=="https",playlistURL.host=="play.xpass.top",playlistURL.user==nil,playlistURL.password==nil,playlistURL.port==nil || playlistURL.port==443,playlistURL.path.hasSuffix("playlist.json") else{throw StandaloneMovieIdentityFailure.unidentified}
        let data=try await read(playlistURL)
        guard let dictionary=try JSONSerialization.jsonObject(with:data) as? [String:Any],let items=dictionary["playlist"] as? [[String:Any]],let sources=items.first?["sources"] as? [[String:Any]],let source=sources.first(where:{($0["type"] as? String)=="hls" || ($0["file"] as? String ?? "").contains(".m3u8")}),let rawSource=source["file"] as? String,let url=URL(string:rawSource),url.scheme=="https",url.host=="vip.1x2.space",url.user==nil,url.password==nil,url.port==nil || url.port==443,!url.path.contains("/error") else{throw StandaloneMovieIdentityFailure.unidentified}
        let headers=["User-Agent":"FlyxStandalone/1.0","Referer":"https://play.xpass.top/"]
        let (master,_)=try await fetch(url,headers:headers,maxBytes:2_097_152);var manifest=String(decoding:master,as:UTF8.self)
        let lines=manifest.components(separatedBy:.newlines)
        if let index=lines.firstIndex(where:{$0.hasPrefix("#EXT-X-STREAM-INF:")}),let path=lines.dropFirst(index+1).first(where:{!$0.isEmpty && !$0.hasPrefix("#")}){
            guard let variant=URL(string:path,relativeTo:url)?.absoluteURL,variant.scheme=="https",variant.host==url.host,variant.user==nil,variant.password==nil,variant.port==nil || variant.port==443 else{throw StandaloneMovieIdentityFailure.unidentified}
            let(bytes,_)=try await fetch(variant,headers:headers,maxBytes:2_097_152);manifest=String(decoding:bytes,as:UTF8.self)
        }
        if let runtime{try StandaloneXPS.verifyDuration(manifest,expectedMinutes:runtime)}else{_ = try StandaloneXPS.clearDuration(manifest)}
        return .init(url:url,headers:headers,format:"hls",provider:"2embed · XPS VIP",quality:source["label"] as? String ?? "Auto",language:"")
    }

    private func providerRead(_ url:URL,host:String,sessionID:String,referer:String)async throws->Data{
        guard url.host==host,providerCookies[sessionID] != nil else{throw RemoteFailure(message:"The provider changed its API host or session.")}
        var headers=["User-Agent":"FlyxStandalone/1.0","Referer":referer]
        let scoped=(providerCookies[sessionID] ?? []).filter{cookie in (cookie.domain==host || cookie.domain=="."+host) && url.path.hasPrefix(cookie.path) && (cookie.expiresDate.map{$0>Date()} ?? true)}
        for(k,v)in HTTPCookie.requestHeaderFields(with:scoped){headers[k]=v}
        let(data,response)=try await fetch(url,headers:headers)
        let fields=Dictionary(response.allHeaderFields.compactMap{key,value->(String,String)? in guard let k=key as? String,let v=value as? String else{return nil};return(k,v)},uniquingKeysWith:{$1})
        var current=providerCookies[sessionID] ?? []
        for cookie in HTTPCookie.cookies(withResponseHeaderFields:fields,for:url){current.removeAll{$0.name==cookie.name && $0.domain==cookie.domain && $0.path==cookie.path};current.append(cookie)}
        providerCookies[sessionID]=current;return data
    }

}
