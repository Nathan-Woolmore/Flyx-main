import Foundation

/// Explicit developer-launch probe. Reads metadata/episodes only through the
/// phone's existing client; exports no credentials, URLs or response bodies.
actor SeriesReadOnlyVerification {
    static let shared = SeriesReadOnlyVerification()
    private var running = false
    private struct Result: Codable {
        let kind: String
        let id: String
        let requestedSeason: Int?
        var success = false
        var selectedSeason: Int?
        var seasons: [Int]?
        var loadedEpisodes: Int?
        var animeEpisodeCount: Int?
        var seasonWarning: Bool?
        var httpStatus: Int?
        var transportErrorCode: Int?
    }
    func run(client: RemoteClient) async {
        guard !running else { return }; running = true
        let cases: [(String,String,Int?)] = [("tv","1396",nil),("tv","1396",0),("tv","70523",2),("tv","1399",nil),("anime","1",nil),("anime","21",nil),("tv","9999999999",nil)]
        var results: [Result] = []
        let file = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("series-verification.json")
        for (kind,id,season) in cases {
            var result=Result(kind:kind,id:id,requestedSeason:season)
            do {
                let value=try await client.details(RemoteTitle(id:id,kind:kind,title:"Verification",overview:"",posterURL:nil),season:season)
                result.success=true;result.selectedSeason=value.selectedSeason;result.seasons=value.seasons.map(\.number);result.loadedEpisodes=value.seasons.reduce(0){$0+$1.episodes.count};result.animeEpisodeCount=value.episodeCount;result.seasonWarning=value.seasonError != nil;result.httpStatus=200
            } catch {result.httpStatus=(error as? RemoteFailure)?.status;result.transportErrorCode=(error as NSError).code}
            results.append(result)
            if let data=try? JSONEncoder().encode(results) {try? data.write(to:file,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])}
        }
    }
}
