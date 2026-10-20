#if DEBUG
import SwiftUI

/// Uses the live provider and ordinary production views inside the separate simulator app.
@MainActor struct StandaloneMangaCheckpoint:View {
    let client:RemoteClient
    @State private var item:RemoteTitle?
    @State private var details:RemoteDetails?
    @State private var watchlist=RemoteWatchlist()
    @State private var error:String?
    var body:some View {NavigationStack{Group{
        if let item,let details {
            if ProcessInfo.processInfo.arguments.contains("--standalone-reader54") || ProcessInfo.processInfo.arguments.contains("--weeb-reader67"){MangaReader(client:client,item:item,chapters:details.chapters ?? [])}
            else{RemoteDetailView(client:client,item:item,watchlist:watchlist)}
        }else if let error{ContentUnavailableView("Manga checkpoint",systemImage:"book.closed",description:Text(error))}
        else{ProgressView("Loading manga…")}
    }}.task{do{
        let weeb=ProcessInfo.processInfo.arguments.contains("--weeb-reader67")
        let title=RemoteTitle(id:weeb ? "Solo-Leveling":"md:6670ee28-f26d-4b61-b49c-d71149cd5a6e",kind:"manga",title:weeb ? "Solo Leveling":"Mieruko-chan",overview:"",posterURL:nil)
        let d=try await client.details(title,season:nil)
        let loaded=RemoteTitle(id:d.id,kind:d.kind,title:d.title,overview:d.overview,posterURL:d.posterURL,releaseDate:d.releaseDate)
        await watchlist.refresh(client)
        if !weeb,!watchlist.contains(loaded){await watchlist.toggle(loaded,client:client)}
        let fresh=RemoteClient(baseURL:URL(string:"https://standalone.invalid")!,standalone:StandaloneService())
        let saved:WatchlistPage=try await fresh.request("/remote/v1/watchlist")
        UIOnlyProtocol.probe(["manga54Title":d.title,"manga54Chapters":d.chapters?.count ?? 0,"manga54WatchlistPersisted":saved.items.contains{$0.id==loaded.id}])
        item=loaded;details=d
    }catch{self.error=error.localizedDescription}}}
}
#endif
