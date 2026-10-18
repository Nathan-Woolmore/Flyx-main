import SwiftUI
import Observation

struct WatchlistPage:Decodable {let items:[RemoteTitle]}
struct WatchlistMutation:Encodable {let operation:String;let kind:String;let id:String}
@MainActor @Observable final class RemoteWatchlist {
    private(set) var items:[RemoteTitle]=[]
    private(set) var loading=false
    private(set) var busy=false
    private(set) var canWrite=false
    private(set) var error:String?
    func contains(_ item:RemoteTitle)->Bool{items.contains{$0.stableID==item.stableID}}
    func refresh(_ client:RemoteClient)async {
        guard !loading else{return};loading=true;defer{loading=false}
        do {let session:RestoredSession=try await client.request("/remote/v1/session");canWrite=session.scopes.contains("watchlist.write");let result:WatchlistPage=try await client.request("/remote/v1/watchlist");try Task.checkCancellation();items=result.items;error=nil}
        catch {if !Task.isCancelled{self.error=error.localizedDescription}}
    }
    func toggle(_ item:RemoteTitle,client:RemoteClient)async {
        guard canWrite,!busy else{return};busy=true;defer{busy=false}
        do {let _:RemoteOK=try await client.request("/remote/v1/watchlist",body:JSONEncoder().encode(WatchlistMutation(operation:contains(item) ? "remove":"add",kind:item.kind,id:item.id)));await refresh(client)}
        catch{self.error=error.localizedDescription}
    }
}
struct WatchlistSaveButton:View {
    let item:RemoteTitle
    let model:RemoteWatchlist
    let client:RemoteClient
    var body:some View {Button {Task{await model.toggle(item,client:client)}}label:{Image(systemName:model.contains(item) ? "bookmark.fill":"bookmark").font(.body.weight(.semibold)).frame(width:44,height:44).foregroundStyle(.white).background(.black.opacity(0.65),in:.circle)}
        .buttonStyle(.plain).disabled(model.busy || !model.canWrite)
        .accessibilityLabel(model.canWrite ? (model.contains(item) ? "Remove from watchlist":"Save to watchlist"):"Watchlist saving requires Mac permission")}
}
struct RemoteWatchlistView:View {
    let client:RemoteClient
    let model:RemoteWatchlist
    var body:some View {NavigationStack {ScrollView {
        VStack(alignment:.leading,spacing:16){
            if !model.canWrite {Text("Allow Watchlist saving for this phone in Flyx on Mac → Settings → Security. Existing saved titles remain browsable.").font(.footnote).foregroundStyle(.secondary)}
            if let error=model.error {Text(error).foregroundStyle(.orange);Button("Retry"){Task{await model.refresh(client)}}}
            LazyVGrid(columns:CatalogLayout.columns,spacing:CatalogLayout.rowSpacing){
                ForEach(model.items,id:\.stableID){item in ZStack(alignment:.topLeading){NavigationLink{RemoteDetailView(client:client,item:item,watchlist:model)}label:{CatalogCard(item:item)}.buttonStyle(.plain);WatchlistSaveButton(item:item,model:model,client:client).padding(8)}}
            }
            if model.items.isEmpty && !model.loading && model.error == nil {ContentUnavailableView("Your Mac watchlist is empty",systemImage:"bookmark",description:Text("Save titles from Browse or their details."))}
        }.padding(16)
    }.navigationTitle("Watchlist").refreshable{await model.refresh(client)}.task{await model.refresh(client)}}}
}
