import Foundation

struct StandaloneHomeDefinition: Sendable {
    let id: String, kind: String, title: String, subtitle: String
    var ranked = false
    var path: String? = nil
    var sort = "popularity"
    var status: String? = nil
    var format: String? = nil
    var tags: [String] = []
    static func rows(_ category: String) throws -> [Self] {
        let movies: [Self] = [
            .init(id:"trending-movies",kind:"movie",title:"Top 10 this week",subtitle:"Movies · Trending this week",ranked:true,path:"/trending/movie/week"),
            .init(id:"popular-movies",kind:"movie",title:"Popular now",subtitle:"Movies everyone is watching",path:"/movie/popular"),
            .init(id:"now-playing",kind:"movie",title:"Now playing",subtitle:"In cinemas now",path:"/movie/now_playing"),
            .init(id:"top-rated-movies",kind:"movie",title:"Top rated movies",subtitle:"Community favorites",path:"/movie/top_rated")]
        let tv: [Self] = [
            .init(id:"trending-tv",kind:"tv",title:category == "tv" ? "Top 10 series this week":"Trending TV",subtitle:"Series · Trending this week",ranked:category == "tv",path:"/trending/tv/week"),
            .init(id:"popular-tv",kind:"tv",title:"Popular series",subtitle:"Discover your next series",path:"/tv/popular"),
            .init(id:"top-rated-tv",kind:"tv",title:"Top rated series",subtitle:"Community favorites",path:"/discover/tv",sort:"rating")]
        let anime: [Self] = [
            .init(id:"popular-anime",kind:"anime",title:category == "anime" ? "Top 10 popular anime":"Popular anime",subtitle:"Fan favorites",ranked:category == "anime"),
            .init(id:"airing-anime",kind:"anime",title:"Currently airing",subtitle:"Fresh episodes this season",status:"RELEASING"),
            .init(id:"top-rated-anime",kind:"anime",title:"Top rated anime",subtitle:"Community favorites",sort:"rating"),
            .init(id:"upcoming-anime",kind:"anime",title:"Upcoming anime",subtitle:"Coming next season",sort:"release_date",status:"NOT_YET_RELEASED"),
            .init(id:"anime-movies",kind:"anime",title:"Anime movies",subtitle:"Feature-length stories",sort:"rating",format:"MOVIE")]
        let manga: [Self] = [
            .init(id:"popular-manga",kind:"manga",title:"Popular manga",subtitle:"Fan-favorite manga"),
            .init(id:"latest-manga",kind:"manga",title:"Latest updates",subtitle:"Recently updated chapters",sort:"release_date"),
            .init(id:"action-manga",kind:"manga",title:"Action & adventure",subtitle:"Epic battles and heroes",tags:["Action","Adventure"]),
            .init(id:"romance-manga",kind:"manga",title:"Romance & drama",subtitle:"Love stories and drama",tags:["Romance","Drama"]),
            .init(id:"fantasy-manga",kind:"manga",title:"Fantasy & isekai",subtitle:"Other worlds and magic",tags:["Fantasy","Isekai"])]
        switch category {
        case "movie":return movies
        case "tv":return tv
        case "anime":return anime
        case "manga":return manga
        case "all":return [movies[0],tv[0],anime[0],movies[1],manga[0],movies[2],movies[3]]
        default:throw RemoteFailure(message:"Choose a Home category.")
        }
    }
}
extension StandaloneService {
    func home(category:String,refresh:Bool) async throws -> Data {
        if !refresh,let (data,date)=homeCache[category],Date().timeIntervalSince(date)<180{return data}
        let definitions=try StandaloneHomeDefinition.rows(category)
        let values=await withTaskGroup(of:(Int,Data).self){group in
            for (index,definition) in definitions.enumerated(){group.addTask{(index,await self.homeRow(definition))}}
            var rows:[(Int,Data)]=[]
            for await value in group{rows.append(value)}
            return rows.sorted{$0.0<$1.0}
        }
        try Task.checkCancellation()
        let sections=try values.map{try JSONSerialization.jsonObject(with:$0.1)}
        let result=try json(["sections":sections,"checkedAt":Date().timeIntervalSince1970*1000,"cached":false])
        homeCache[category]=(result,Date());return result
    }
    private func homeRow(_ definition:StandaloneHomeDefinition)async -> Data {
        let cacheKey=definition.id+(definition.ranked ? ":ranked":":plain")
        var row:[String:Any]=["id":definition.id,"kind":definition.kind,"title":definition.title,"subtitle":definition.subtitle,"source":definition.kind=="anime" ? "AniList":definition.kind=="manga" ? "WeebCentral":"TMDB","ranked":definition.ranked,"stale":false]
        do {
            let items:[[String:Any]]
            if let path=definition.path {
                var query:[URLQueryItem]=[]
                if definition.id=="top-rated-tv"{query=[.init(name:"sort_by",value:"vote_average.desc"),.init(name:"vote_count.gte",value:"10")]}
                let result=try await tmdb(path,query:query)
                items=remember((result["results"] as? [[String:Any]] ?? []).map{normalizeTMDB($0,kind:definition.kind)})
            } else if definition.kind=="anime" {
                var filters=["sort":definition.sort]
                if let status=definition.status{filters["homeStatus"]=status}
                if let format=definition.format{filters["homeFormat"]=format}
                items=remember(try await animeCatalogue(query:"",page:1,filters:filters).0)
            } else {
                items=remember(try await weebCatalogue(query:"",page:1,sort:definition.sort,tags:definition.tags).0)
            }
            var seen=Set<String>()
            row["items"]=items.filter{seen.insert(String(describing:$0["id"] ?? "")).inserted}.prefix(definition.ranked ? 10:16).enumerated().map{index,item->[String:Any] in
                var entry:[String:Any]=["id":definition.kind+":"+String(describing:item["id"] ?? ""),"title":item]
                if definition.ranked{entry["rank"]=index+1};return entry
            }
            row["updatedAt"]=Date().timeIntervalSince1970*1000
            let data=try json(row);homeRowCache[cacheKey]=data;return data
        } catch {
            if let data=homeRowCache[cacheKey],var previous=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]{previous["stale"]=true;previous["error"]="Could not refresh this row. Showing previously loaded titles.";return (try? json(previous)) ?? Data()}
            row["items"]=[];row["error"]=definition.kind=="movie" || definition.kind=="tv" ? "This feed is unavailable. Check TMDB access in Settings or pull to retry.":"This feed is temporarily unavailable. Pull to retry."
            return (try? json(row)) ?? Data()
        }
    }
}
