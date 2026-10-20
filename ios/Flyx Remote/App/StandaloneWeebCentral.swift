import Foundation

extension StandaloneService {
    private func weebRead(_ path:String,query:[URLQueryItem]=[])async throws->String {
        var c=URLComponents(string:"https://weebcentral.com")!;c.path=path;c.queryItems=query.isEmpty ? nil:query
        let(data,_)=try await fetch(c.url!,headers:["User-Agent":"Mozilla/5.0","Accept":"text/html"])
        guard data.count<=8_388_608 else{throw RemoteFailure(message:"The manga metadata response is too large.")}
        return String(decoding:data,as:UTF8.self)
    }
    private func weebSearch(_ text:String,sort:String)async throws->[WeebSeries] {
        let html=try await weebRead("/search/data",query:[.init(name:"text",value:text),.init(name:"author",value:""),.init(name:"sort",value:sort),.init(name:"order",value:"Descending"),.init(name:"anime",value:"Any"),.init(name:"adult",value:"Any"),.init(name:"display_mode",value:"Full Display")])
        let items=try WeebCentralPage.series(html)
        for item in items.prefix(200){weebSeries[item.slug]=item}
        if weebSeries.count>400{let keep=Set(items.prefix(200).map(\.slug));weebSeries=weebSeries.filter{keep.contains($0.key)}}
        return items
    }
    func weebCatalogue(query:String,page:Int,sort:String,tags:[String]=[])async throws->([[String:Any]],Bool) {
        guard page==1 else{return([],false)}
        let text=query.isEmpty ? (tags.first?.lowercased() ?? ""):query
        let ordering=text.isEmpty ? (sort=="release_date" ? "Latest Updates":"Popularity"):"Best Match"
        return(try await weebSearch(text,sort:ordering).prefix(20).map{["id":$0.slug,"kind":"manga","title":$0.title,"overview":"","posterURL":$0.posterURL as Any? ?? NSNull()]},false)
    }
    func weebDetails(_ id:String)async throws->[String:Any] {
        guard id.range(of:"^[A-Za-z0-9._-]{1,300}$",options:.regularExpression) != nil else{throw RemoteFailure(message:"Choose a valid manga title.")}
        let series:WeebSeries
        if let cached=weebSeries[id]{series=cached}
        else{
            let results=try await weebSearch(id.replacingOccurrences(of:"-",with:" "),sort:"Best Match")
            guard let exact=results.first(where:{$0.slug.caseInsensitiveCompare(id) == .orderedSame}) else{throw RemoteFailure(message:"This manga is no longer listed by the provider.",status:404)}
            series=exact
        }
        let html=try await weebRead("/series/\(series.providerID)/\(series.slug)")
        guard html.contains("full-chapter-list") else{throw RemoteFailure(message:"The manga provider did not return this title's details.")}
        let chapterHTML=try await weebRead("/series/\(series.providerID)/full-chapter-list")
        let chapters=try WeebCentralPage.chapters(chapterHTML)
        for chapter in chapters{mangaChapters[chapter.id]=["mangaID":id,"chapter":["number":chapter.number,"language":chapter.language,"edition":chapter.edition]]}
        func field(_ label:String)->String{(try? WeebCentralPage.matches("<li>\\s*<strong>"+label+"\\s*</strong>(.*?)</li>",html).first?[1]).map(WeebCentralPage.text) ?? ""}
        let description=field("Description"),year=field("Released:")
        var item:[String:Any]=["id":id,"kind":"manga","title":series.title,"overview":description,"posterURL":series.posterURL as Any? ?? NSNull(),"seasons":[],"episodeCount":NSNull(),"chapters":try JSONSerialization.jsonObject(with:JSONEncoder().encode(chapters)),"metadata":[["label":"Source","value":"WeebCentral"],["label":"Status","value":field("Status:")],["label":"Author","value":field("Author\\(s\\):")],["label":"Chapters","value":"\(chapters.count) English chapters"]]]
        if !year.isEmpty{item["releaseDate"]=String(year.prefix(4))}
        if chapters.isEmpty{item["chapterUnavailable"]="This provider currently lists no chapters for this title."}
        titles["manga:"+id]=item;return item
    }
    func weebChapter(_ body:[String:Any])async throws->[String:Any] {
        guard let mangaID=body["mangaID"] as? String,let chapterID=body["chapterID"] as? String,
              chapterID.range(of:"^[0-9A-HJKMNP-TV-Z]{26}$",options:.regularExpression) != nil,
              let record=mangaChapters[chapterID],record["mangaID"] as? String==mangaID,let chapter=record["chapter"] as? [String:Any] else{throw RemoteFailure(message:"Reopen this manga to refresh its chapter list.")}
        let html=try await weebRead("/chapters/\(chapterID)/images",query:[.init(name:"is_prev",value:"False"),.init(name:"current_page",value:"1")])
        let pages=try WeebCentralPage.pages(html)
        mangaAccess=mangaAccess.filter{$0.value.expires>Date()};if mangaAccess.count>=5,let oldest=mangaAccess.min(by:{$0.value.expires<$1.value.expires})?.key{mangaAccess.removeValue(forKey:oldest)}
        let handle=UUID().uuidString,number=chapter["number"] as? Double ?? 0,edition=chapter["edition"] as? String ?? "community"
        mangaAccess[handle] = .init(mangaID:mangaID,chapterID:chapterID,number:number,language:"en",edition:edition,pages:pages,expires:Date().addingTimeInterval(900),provider:"weebcentral")
        return ["handle":handle,"pageCount":pages.count,"provider":"weebcentral","mangaID":mangaID,"chapterID":chapterID,"chapterNumber":number,"language":"en","edition":edition]
    }
}
