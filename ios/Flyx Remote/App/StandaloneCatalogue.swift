import Foundation

extension StandaloneService {
    func catalogueKey(kind:String,query:String,page:Int,filters:[String:String])->String{kind+":"+query+":"+String(page)+":"+filters.sorted{$0.key<$1.key}.map{$0.key+"="+$0.value}.joined(separator:"&")}
    func catalogue(kind:String,query:String,page:Int,filters:[String:String]=[:])async throws->[[String:Any]] {
        guard (1...250).contains(page),query.count<=100 else{throw RemoteFailure(message:"Choose a shorter search or reopen this catalogue.")}
        let key=catalogueKey(kind:kind,query:query,page:page,filters:filters)
        if let(value,date)=catalogueCache[key],Date().timeIntervalSince(date)<180{return value}
        let items:[[String:Any]],more:Bool
        if kind=="manga"{(items,more)=try await weebCatalogue(query:query,page:page,sort:filters["sort"] ?? "popularity")}
        else if kind=="anime"{(items,more)=try await animeCatalogue(query:query,page:page,filters:filters)}
        else if kind=="movie" || kind=="tv" {
            var values=[URLQueryItem(name:"page",value:String(page))]
            let sort=filters["sort"] ?? "popularity",date=kind=="movie" ? "primary_release_date":"first_air_date"
            if !query.isEmpty{values.append(.init(name:"query",value:query))}
            else {
                values.append(.init(name:"sort_by",value:sort=="release_date" ? date+".desc":sort=="rating" ? "vote_average.desc":"popularity.desc"))
                if let genre=filters["genre"],!genre.isEmpty{values.append(.init(name:"with_genres",value:genre))}
                if let from=filters["yearFrom"],let year=Int(from){values.append(.init(name:date+".gte",value:"\(year)-01-01"))}
                if let to=filters["yearTo"],let year=Int(to){values.append(.init(name:date+".lte",value:"\(year)-12-31"))}
                if let rating=filters["minRating"],Int(rating) != nil{values.append(.init(name:"vote_average.gte",value:rating))}
                if sort=="rating"{values.append(.init(name:"vote_count.gte",value:filters["minVotes"] ?? "10"))}
            }
            let data=try await tmdb(query.isEmpty ? "/discover/"+kind:"/search/"+kind,query:values)
            let raw=data["results"] as? [[String:Any]] ?? []
            items=raw.filter{row in
                guard !query.isEmpty else{return true}
                if let genre=filters["genre"],let id=Int(genre),!(row["genre_ids"] as? [Int] ?? []).contains(id){return false}
                let year=Int(String((row["release_date"] as? String ?? row["first_air_date"] as? String ?? "").prefix(4))) ?? 0
                if let from=Int(filters["yearFrom"] ?? ""),year<from{return false};if let to=Int(filters["yearTo"] ?? ""),year>to{return false}
                if let rating=Double(filters["minRating"] ?? ""),(row["vote_average"] as? Double ?? 0)<rating{return false};return true
            }.map{normalizeTMDB($0,kind:kind)}
            more=page<(data["total_pages"] as? Int ?? 1) && page<250
        }else{throw RemoteFailure(message:"Choose Movies, TV, Anime or Manga.")}
        nextPages[key]=more ? page+1:0
        if catalogueCache.count>=24,let oldest=catalogueCache.min(by:{$0.value.1<$1.value.1})?.key{catalogueCache.removeValue(forKey:oldest);nextPages.removeValue(forKey:oldest)}
        catalogueCache[key]=(items,Date());return remember(items)
    }
    func animeCatalogue(query:String,page:Int,filters:[String:String])async throws->([[String:Any]],Bool){
        let genres=["1":"Action","2":"Adventure","4":"Comedy","8":"Drama","10":"Fantasy","14":"Horror","7":"Mystery","22":"Romance","24":"Sci-Fi","36":"Slice of Life","30":"Sports","37":"Supernatural","41":"Thriller"]
        let sort=filters["sort"] ?? "popularity"
        var variables:[String:Any]=["page":page,"search":query.isEmpty ? NSNull():query as Any,"sort":[sort=="release_date" ? "START_DATE_DESC":sort=="rating" ? "SCORE_DESC":"POPULARITY_DESC"]]
        var declarations=["$page:Int","$search:String","$sort:[MediaSort]"],arguments=["type:ANIME","sort:$sort","isAdult:false","search:$search"]
        if let status=filters["homeStatus"],["RELEASING","NOT_YET_RELEASED"].contains(status){declarations.append("$status:MediaStatus");arguments.append("status:$status");variables["status"]=status}
        if let format=filters["homeFormat"],format=="MOVIE"{declarations.append("$format:MediaFormat");arguments.append("format:$format");variables["format"]=format}
        if let id=filters["genre"],let genre=genres[id]{declarations.append("$genre:String");arguments.append("genre:$genre");variables["genre"]=genre}
        if let from=Int(filters["yearFrom"] ?? ""){declarations.append("$from:FuzzyDateInt");arguments.append("startDate_greater:$from");variables["from"]=from*10000}
        if let to=Int(filters["yearTo"] ?? ""){declarations.append("$to:FuzzyDateInt");arguments.append("startDate_lesser:$to");variables["to"]=(to+1)*10000}
        if let score=Int(filters["minRating"] ?? ""),score>0{declarations.append("$score:Int");arguments.append("averageScore_greater:$score");variables["score"]=score*10-1}
        let graph="query(\(declarations.joined(separator:","))){Page(page:$page,perPage:20){pageInfo{hasNextPage}media(\(arguments.joined(separator:","))){idMal title{english romaji}description coverImage{large}averageScore episodes startDate{year}stats{scoreDistribution{amount}}}}}"
        let data=try await fetchJSON("https://graphql.anilist.co",body:["query":graph,"variables":variables])
        guard let root=data["data"] as? [String:Any],let p=root["Page"] as? [String:Any],let rows=p["media"] as? [[String:Any]] else{throw RemoteFailure(message:"AniList could not load these filters. Try another search.")}
        let items=rows.compactMap{v->[String:Any]? in guard let id=v["idMal"] as? Int else{return nil};let item=animeTitle(v,id:id);if filters["sort"]=="rating",(item["voteCount"] as? Int ?? 0)<(Int(filters["minVotes"] ?? "10") ?? 10){return nil};return item}
        return(items,(p["pageInfo"] as? [String:Any])?["hasNextPage"] as? Bool ?? false)
    }
    func animeTitle(_ v:[String:Any],id:Int)->[String:Any]{
        let names=v["title"] as? [String:Any] ?? [:],cover=v["coverImage"] as? [String:Any] ?? [:],date=v["startDate"] as? [String:Any] ?? [:]
        let distribution=((v["stats"] as? [String:Any])?["scoreDistribution"] as? [[String:Any]] ?? []).reduce(0){$0+($1["amount"] as? Int ?? 0)}
        return ["voteCount":distribution,"id":String(id),"kind":"anime","title":names["english"] as? String ?? names["romaji"] as? String ?? "Anime","overview":(v["description"] as? String ?? "").replacingOccurrences(of:"<[^>]+>",with:"",options:.regularExpression),"posterURL":cover["large"] ?? NSNull(),"rating":(v["averageScore"] as? Double).map{$0/10} as Any? ?? NSNull(),"releaseDate":date["year"].map{String(describing:$0)} ?? ""]
    }
    func animeDetails(_ id:String)async throws->[String:Any]{
        guard let number=Int(id),number>0 else{throw RemoteFailure(message:"Choose a valid anime title.")}
        let data=try await fetchJSON("https://graphql.anilist.co",body:["query":"query($id:Int){Media(idMal:$id,type:ANIME){idMal title{english romaji}description coverImage{large}averageScore episodes format startDate{year}status genres stats{scoreDistribution{amount}}}}","variables":["id":number]])
        guard let root=data["data"] as? [String:Any],let value=root["Media"] as? [String:Any],value["idMal"] as? Int==number else{throw RemoteFailure(message:"AniList did not return this anime's details.")}
        var d=animeTitle(value,id:number);d["seasons"]=[];d["episodeCount"]=value["episodes"] ?? 0
        do{_ = try await mapAnime(value,id:number)}catch is CancellationError{throw CancellationError()}catch{d["playbackUnavailable"]=error.localizedDescription}
        d["metadata"]=[["label":"Catalogue","value":"AniList"],["label":"Genres","value":(value["genres"] as? [String] ?? []).joined(separator:", ")],["label":"Edition","value":"MyAnimeList ID \(number)"],["label":"Streaming","value":animeMappings[number]==nil ? "AnimeX unavailable":"AnimeX · exact MAL edition"]]
        titles["anime:"+id]=d;return d
    }
}
