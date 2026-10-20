#if DEBUG
import SwiftUI

@MainActor struct StandaloneCoverageCheckpoint:View {
    let client:RemoteClient
    @Environment(\.applicationMode) private var mode
    @State private var item:RemoteTitle?
    @State private var message="Checking live anime discovery…"
    var body:some View {Group{if let item{RemoteDetailView(client:client,item:item)}else{VStack(spacing:20){ProgressView();Text(message).multilineTextAlignment(.center)}.padding()}}.task{await verify()}}
    private func verify()async{
        var report:[String:Any]=[:]
        do{
            let search=CatalogRequest(kind:"anime",query:"Cowboy Bebop")
            let found=try await client.catalog(search,page:1)
            report["searchCount"]=found.items.count;report["searchFoundCowboyBebop"]=found.items.contains{$0.id=="1"}
            guard let chosen=found.items.first(where:{$0.id=="1"}) else{throw RemoteFailure(message:"The requested anime was absent from live search.")}
            var filtered=search;filtered.filters.genre="8";filtered.filters.yearFrom="1990";filtered.filters.yearTo="2000";filtered.filters.minRating=8
            let result=try await client.catalog(filtered,page:1)
            report["filterCount"]=result.items.count;report["filterFoundCowboyBebop"]=result.items.contains{$0.id=="1"};report["filterYearsAndRatingsMatch"]=result.items.allSatisfy{(1990...2000).contains(Int(String(($0.releaseDate ?? "").prefix(4))) ?? 0) && ($0.rating ?? 0)>=8}
            let details=try await client.details(chosen,season:nil);report["detailsTitle"]=details.title;report["detailsEpisodeCount"]=details.episodeCount ?? 0;report["detailsOverviewPresent"] = !details.overview.isEmpty
            let first=try await client.catalog(CatalogRequest(kind:"anime"),page:1)
            let second=try await client.catalog(CatalogRequest(kind:"anime"),page:2)
            report["pageOneCount"]=first.items.count;report["pageTwoCount"]=second.items.count;report["paginationDistinct"]=Set(first.items.map(\.id)).isDisjoint(with:Set(second.items.map(\.id)))
            var rated=CatalogRequest(kind:"anime");rated.filters.sort="rating";rated.filters.minVotes=1000
            let rating=try await client.catalog(rated,page:1);report["qualifiedRatingCount"]=rating.items.count;report["voteThresholdMatches"] = !rating.items.isEmpty && rating.items.allSatisfy{($0.voteCount ?? 0)>=1000}
            item=RemoteTitle(id:details.id,kind:details.kind,title:details.title,overview:details.overview,posterURL:details.posterURL,rating:details.rating,releaseDate:details.releaseDate,voteCount:details.voteCount)
        }catch{report["discoveryError"]=error.localizedDescription;message=error.localizedDescription}
        if let mode{
            mode.choose(.standalone);mode.playback.status=PlaybackStatus(state:"playing",position:10,duration:100,title:"Inert remote status",output:"mac",outputName:"Mac")
            let epoch=mode.playback.epoch;mode.choose(.remote)
            report["modeClearsOldOutput"]=mode.mode == .remote && mode.playback.status==nil && mode.playback.epoch>epoch
            mode.playback.phone.busy=true;mode.choose(.standalone);report["modeBlocksPreparation"]=mode.mode == .remote
            mode.playback.phone.busy=false;mode.playback.phone.ready=true;mode.choose(.standalone);report["modeBlocksActivePhone"]=mode.mode == .remote
            mode.playback.phone.ready=false;mode.playback.busy=true;mode.choose(.standalone);report["modeBlocksBusyTransaction"]=mode.mode == .remote
            mode.playback.busy=false;mode.choose(.standalone);report["modeReturnsStandalone"]=mode.mode == .standalone
        }
        let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:root.appendingPathComponent("standalone-coverage54.json"),options:.atomic)}
    }
}
#endif
