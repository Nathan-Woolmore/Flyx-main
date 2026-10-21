import Foundation

/// Explicit developer-launch verification. Uses the app's existing scoped client;
/// never exports its credential or issues player, TV, volume or download requests.
actor CatalogReadOnlyVerification {
    static let shared = CatalogReadOnlyVerification()
    private var running = false
    private struct Result: Codable {
        let check: String
        let kind: String
        var success: Bool
        var itemCount: Int?
        var nextPage: Int?
        var httpStatus: Int?
    }
    func run(client: RemoteClient) async {
        guard !running else { return }; running = true
        let current = Calendar.current.component(.year, from: Date())
        var checks = ["movie","tv","anime","manga"].map { ("browse",CatalogRequest(kind:$0)) }
        checks.append(("search",CatalogRequest(kind:"movie",query:"star")))
        checks.append(("combined",CatalogRequest(kind:"movie",query:"star",filters:CatalogFilters(genre:"878",yearFrom:"1970",yearTo:String(current),minRating:5,sort:"popularity"))))
        checks.append(("combined",CatalogRequest(kind:"tv",query:"star",filters:CatalogFilters(genre:"10765",yearFrom:"1970",yearTo:String(current),minRating:5,sort:"popularity"))))
        checks.append(("combined",CatalogRequest(kind:"anime",query:"Naruto",filters:CatalogFilters(genre:"1",yearFrom:"1990",yearTo:String(current),minRating:6,sort:"rating"))))
        checks.append(("search",CatalogRequest(kind:"manga",query:"One Piece")))
        var results: [Result] = []
        let file = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("catalogue-verification.json")
        for (label,selection) in checks {
            do {
                let page = try await client.catalog(selection)
                results.append(Result(check:label,kind:selection.kind,success:true,itemCount:page.items.count,nextPage:page.nextPage,httpStatus:200))
            } catch {
                results.append(Result(check:label,kind:selection.kind,success:false,httpStatus:(error as? RemoteFailure)?.status))
            }
            // Bounded count/status metadata only; no titles, query text, URL or errors with secrets.
            if let data = try? JSONEncoder().encode(results) {
                try? FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
                try? data.write(to:file,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
            }
        }
    }
}
