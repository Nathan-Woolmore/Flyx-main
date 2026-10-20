import Foundation

struct StandaloneMangaPages:Sendable {
    let mangaID:String;let chapterID:String;let number:Double;let language:String;let edition:String;let pages:[URL];let expires:Date;var provider:String="mangadex"
}
extension StandaloneService {
    func mangaDex(_ path:String,query:[URLQueryItem]=[])async throws->[String:Any]{
        var c=URLComponents(string:"https://api.mangadex.org"+path)!;c.queryItems=query.isEmpty ? nil:query
        return try await fetchJSON(c.url!.absoluteString)
    }
    func mangaTitle(_ d:[String:Any])->[String:Any]{
        let a=d["attributes"] as? [String:Any] ?? [:],id=d["id"] as? String ?? "",titles=a["title"] as? [String:String] ?? [:],alternates=a["altTitles"] as? [[String:String]] ?? []
        let title=titles["en"] ?? alternates.compactMap{$0["en"]}.first ?? titles.sorted{$0.key<$1.key}.first?.value ?? "Manga"
        let description=(a["description"] as? [String:String])?["en"] ?? ""
        let cover=(d["relationships"] as? [[String:Any]] ?? []).first{$0["type"] as? String=="cover_art"}?["attributes"] as? [String:Any]
        var item:[String:Any]=["id":"md:"+id,"kind":"manga","title":title,"overview":description,"posterURL":NSNull(),"releaseDate":a["year"].map{String(describing:$0)} ?? ""]
        if let filename=cover?["fileName"] as? String,let encoded=filename.addingPercentEncoding(withAllowedCharacters:.urlPathAllowed){item["posterURL"]="https://uploads.mangadex.org/covers/\(id)/\(encoded).256.jpg"}
        return item
    }
    func mangaCatalogue(query:String,page:Int,sort:String,tags:[String]=[])async throws->([[String:Any]],Bool){
        var q:[URLQueryItem]=[.init(name:"limit",value:"20"),.init(name:"offset",value:String((page-1)*20)),.init(name:"includes[]",value:"cover_art"),.init(name:"contentRating[]",value:"safe"),.init(name:"contentRating[]",value:"suggestive")]
        q.append(contentsOf:[.init(name:"availableTranslatedLanguage[]",value:"en"),.init(name:"hasAvailableChapters",value:"true")])
        if !tags.isEmpty {
            if mangaTags.isEmpty{let reply=try await mangaDex("/manga/tag");for tag in reply["data"] as? [[String:Any]] ?? []{if let id=tag["id"] as? String,let name=((tag["attributes"] as? [String:Any])?["name"] as? [String:String])?["en"]{mangaTags[name]=id}}}
            let ids=tags.compactMap{mangaTags[$0]};guard ids.count==tags.count else{throw RemoteFailure(message:"Manga genre filters are temporarily unavailable.")}
            q.append(.init(name:"includedTagsMode",value:"OR"));q.append(contentsOf:ids.map{.init(name:"includedTags[]",value:$0)})
        }
        if !query.isEmpty{q.append(.init(name:"title",value:query));q.append(.init(name:"order[relevance]",value:"desc"))}
        else{q.append(.init(name:sort=="release_date" ? "order[latestUploadedChapter]":"order[followedCount]",value:"desc"))}
        let d=try await mangaDex("/manga",query:q),raw=d["data"] as? [[String:Any]] ?? []
        return(raw.map(mangaTitle),page*20<(d["total"] as? Int ?? 0))
    }
    func mangaDetails(_ id:String)async throws->[String:Any]{
        if !id.hasPrefix("md:"){return try await weebDetails(id)}
        guard id.hasPrefix("md:"),UUID(uuidString:String(id.dropFirst(3))) != nil else{throw RemoteFailure(message:"This manga belongs to the Mac catalogue. Open it in Mac Remote mode.")}
        let uuid=String(id.dropFirst(3)),response=try await mangaDex("/manga/"+uuid,query:[.init(name:"includes[]",value:"cover_art"),.init(name:"includes[]",value:"author")])
        guard let raw=response["data"] as? [String:Any] else{throw RemoteFailure(message:"MangaDex did not return this title.")}
        var item=mangaTitle(raw);let a=raw["attributes"] as? [String:Any] ?? [:]
        var chapters:[[String:Any]]=[],offset=0,total=1
        // At most ten metadata pages per title; the UI states this bound if more remain.
        while offset<total,offset<1000 {
            let d=try await mangaDex("/manga/\(uuid)/feed",query:[.init(name:"limit",value:"100"),.init(name:"offset",value:String(offset)),.init(name:"translatedLanguage[]",value:"en"),.init(name:"order[chapter]",value:"asc"),.init(name:"includes[]",value:"scanlation_group"),.init(name:"includeExternalUrl",value:"0")])
            let rows=d["data"] as? [[String:Any]] ?? [];total=d["total"] as? Int ?? 0
            for row in rows {
                guard let chapterID=row["id"] as? String,let attrs=row["attributes"] as? [String:Any],attrs["externalUrl"] as? String==nil,(attrs["pages"] as? Int ?? 0)>0 else{continue}
                let number=Double(attrs["chapter"] as? String ?? "") ?? 0,language=attrs["translatedLanguage"] as? String ?? "en"
                let groups=(row["relationships"] as? [[String:Any]] ?? []).filter{$0["type"] as? String=="scanlation_group"}
                let edition=groups.compactMap{$0["id"] as? String}.sorted().joined(separator:"+")
                let key="md:"+chapterID,title=attrs["title"] as? String ?? ""
                let chapter:[String:Any]=["id":key,"number":number,"title":title.isEmpty ? "Chapter \(attrs["chapter"] as? String ?? "Special")":title,"language":language,"edition":edition.isEmpty ? "unlabeled:"+chapterID:edition,"editionLabel":groups.compactMap{($0["attributes"] as? [String:Any])?["name"] as? String}.joined(separator:", ")]
                mangaChapters[key]=["mangaID":id,"chapter":chapter];chapters.append(chapter)
            }
            offset+=rows.count;if rows.isEmpty{break};try Task.checkCancellation()
        }
        item["seasons"]=[];item["episodeCount"]=NSNull();item["chapters"]=chapters
        if chapters.isEmpty{item["chapterUnavailable"]="MangaDex does not currently host English chapters for this title. This is different from a network or page-loading failure."}
        let authors=(raw["relationships"] as? [[String:Any]] ?? []).filter{$0["type"] as? String=="author"}.compactMap{($0["attributes"] as? [String:Any])?["name"] as? String}.joined(separator:", ")
        item["metadata"]=[["label":"Source","value":"MangaDex"],["label":"Status","value":a["status"] as? String ?? "Unknown"],["label":"Author","value":authors.isEmpty ? "Not supplied":authors],["label":"Chapters","value":chapters.isEmpty ? "No hosted English chapters are currently available.":"\(chapters.count) hosted English chapters\(offset<total ? " · first 1,000 entries":"")"]]
        titles["manga:"+id]=item;return item
    }
    func mangaChapter(_ b:[String:Any])async throws->[String:Any]{
        if let id=b["mangaID"] as? String,!id.hasPrefix("md:"){return try await weebChapter(b)}
        guard let mangaID=b["mangaID"] as? String,let chapterID=b["chapterID"] as? String,chapterID.hasPrefix("md:"),let record=mangaChapters[chapterID],record["mangaID"] as? String==mangaID,let chapter=record["chapter"] as? [String:Any] else{throw RemoteFailure(message:"Reopen this manga to refresh its hosted chapter list.")}
        let d=try await mangaDex("/at-home/server/"+String(chapterID.dropFirst(3)))
        guard let raw=d["chapter"] as? [String:Any],let hash=raw["hash"] as? String,let base=d["baseUrl"] as? String,let address=URL(string:base),address.scheme=="https",let files=raw["dataSaver"] as? [String],(1...1000).contains(files.count) else{throw RemoteFailure(message:"MangaDex has no readable hosted pages for this chapter.")}
        let pages=try files.map{try Self.mangaPageURL(base:address,hash:hash,filename:$0)}
        mangaAccess=mangaAccess.filter{$0.value.expires>Date()};if mangaAccess.count>=5,let oldest=mangaAccess.min(by:{$0.value.expires<$1.value.expires})?.key{mangaAccess.removeValue(forKey:oldest)}
        let handle=UUID().uuidString,number=chapter["number"] as? Double ?? 0,language=chapter["language"] as? String ?? "en",edition=chapter["edition"] as? String ?? "unknown"
        mangaAccess[handle] = .init(mangaID:mangaID,chapterID:chapterID,number:number,language:language,edition:edition,pages:pages,expires:Date().addingTimeInterval(900))
        return ["handle":handle,"pageCount":pages.count,"provider":"mangadex","mangaID":mangaID,"chapterID":chapterID,"chapterNumber":number,"language":language,"edition":edition]
    }
    static func mangaPageURL(base:URL,hash:String,filename:String)throws->URL{
        guard base.scheme=="https",base.host != nil,base.user==nil,base.password==nil,!hash.isEmpty,!hash.contains("/"),!filename.isEmpty,!filename.contains("/"),filename != ".",filename != ".." else{throw RemoteFailure(message:"The chapter page list is invalid.")}
        return base.appendingPathComponent("data-saver").appendingPathComponent(hash).appendingPathComponent(filename)
    }
    func mangaImage(_ q:[String:String])async throws->Data{
        guard let handle=q["handle"],let chapter=mangaAccess[handle],chapter.expires>Date(),let page=Int(q["page"] ?? ""),(1...chapter.pages.count).contains(page) else{throw RemoteFailure(message:"Reopen the chapter to refresh its pages.")}
        do{
            let(data,response)=try await fetch(chapter.pages[page-1]);guard data.count<=8_388_608,response.value(forHTTPHeaderField:"Content-Type")?.lowercased().hasPrefix("image/")==true else{throw RemoteFailure(message:"The chapter page is not a supported image.")};return data
        }catch let failure as RemoteFailure where [403,451].contains(failure.status ?? 0){
            throw RemoteFailure(message:"The \(chapter.provider=="mangadex" ? "MangaDex":"manga") image provider refused access (HTTP \(failure.status ?? 403)). Reading is unavailable.",status:failure.status)
        }catch let failure as RemoteFailure where failure.status==404{
            throw RemoteFailure(message:"This page is no longer available from the manga provider (HTTP 404). Reopen the chapter to refresh its page list.",status:404)
        }
    }
}
