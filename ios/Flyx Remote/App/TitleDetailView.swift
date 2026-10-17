import SwiftUI

struct RemoteDetailView:View {
    let client:RemoteClient
    let item:RemoteTitle
    var watchlist:RemoteWatchlist?=nil
    @State private var details:RemoteDetails?
    @State private var directPhone=false
    @State private var destination="mac"
    @State private var savedProgress:SeriesProgress?
    @State private var progressSupported=false
    @State private var progressLoaded=false
    @State private var progressApplied=false
    @State private var startOver=false
    @State private var playerPresentation:PlayerPresentation?
    @State private var selectedSeason:Int?
    @State private var selectedEpisode:Int?
    @State private var loadingDetails=true
    @State private var busy=false
    @State private var error:String?
    @State private var message:String?
    @State private var retry=0
    private var activeSeason:Int?{selectedSeason ?? details?.selectedSeason ?? details?.seasons.first(where:{$0.number>0})?.number ?? details?.seasons.first?.number}
    private var episodes:[DetailEpisode]{
        guard item.kind=="tv" || item.kind=="anime" else{return []}
        if item.kind=="anime",let count=details?.episodeCount,count>0{return(1...min(count,1000)).map{.init(number:$0,title:"Episode \($0)")}}
        return details?.seasons.first(where:{$0.number==activeSeason})?.episodes.map{.init(number:$0.number,title:$0.title)} ?? []
    }
    private var episode:Int?{if let selectedEpisode,episodes.contains(where:{$0.number==selectedEpisode}){return selectedEpisode};if let savedProgress,savedProgress.completed,(item.kind=="anime" || activeSeason==savedProgress.season){return episodes.first(where:{$0.number>savedProgress.episode})?.number};return episodes.first?.number}
    private var episodeLabel:String?{guard let episode else{return nil};return item.kind=="anime" ? "Episode \(episode)":(activeSeason==0 ? "Special · Episode \(episode)":"Season \(activeSeason ?? 1) · Episode \(episode)")}
    private var resumePosition:Double?{guard !startOver,let savedProgress,!savedProgress.completed,savedProgress.kind==item.kind,(item.kind=="movie" || (savedProgress.season==(item.kind=="anime" ? 1:activeSeason) && savedProgress.episode==episode))else{return startOver ? 0:nil};return savedProgress.position>5 ? savedProgress.position:nil}
    private var playLabel:String{guard let position=resumePosition,position>0 else{return !startOver && savedProgress?.completed==true && episode != nil && (item.kind=="anime" ? (episode ?? 0)>(savedProgress?.episode ?? 0) : (activeSeason ?? 0)>(savedProgress?.season ?? 0) || (activeSeason==savedProgress?.season && (episode ?? 0)>(savedProgress?.episode ?? 0))) ? "Play next episode":"Play"};return item.kind=="movie" ? "Continue":"Continue S\(item.kind=="anime" ? 1:activeSeason ?? 1) E\(episode ?? 1)"}
    var body:some View {
        ScrollView{VStack(alignment:.leading,spacing:24){
            RemotePoster(item:item).frame(height:280).clipShape(.rect(cornerRadius:20))
            VStack(alignment:.leading,spacing:10){Text(item.title).font(.largeTitle.bold()).fixedSize(horizontal:false,vertical:true);TitleFacts(item:item,details:details)}
            if details != nil,item.kind != "manga"{playbackArea}
            else if let details,item.kind=="manga"{MangaChapterSection(client:client,item:item,chapters:details.chapters ?? [])}
            if let watchlist{HStack(spacing:10){WatchlistSaveButton(item:item,model:watchlist,client:client);Text(watchlist.contains(item) ? "Saved on Mac":"Save to Mac watchlist").font(.subheadline)};if !watchlist.canWrite{Text("Allow watchlist saving in Flyx on Mac.").font(.caption).foregroundStyle(.secondary)}}
            let overview=details?.overview ?? item.overview
            if !overview.isEmpty{VStack(alignment:.leading,spacing:10){Text("Overview").font(.headline);Text(overview).font(.body).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)}}
            if let metadata=details?.metadata,!metadata.isEmpty{TitleInformation(rows:metadata)}
            if loadingDetails{VStack(spacing:12){ForEach(0..<3,id:\.self){_ in RoundedRectangle(cornerRadius:8).fill(.quaternary).frame(height:44)}}.loadingShimmer().accessibilityLabel("Loading title details")}
            if let message{Text(message).font(.footnote).foregroundStyle(FlyxTheme.accent)}
            if let error{VStack(alignment:.leading,spacing:8){Text(error).font(.footnote).foregroundStyle(.orange);Button("Retry details"){retry+=1}}}
        }.padding(24)}.background(.black).navigationBarTitleDisplayMode(.inline)
            .fullScreenCover(item:$playerPresentation){value in RemoteControlView(client:client,initialSelection:value.selection,initialItem:item,startsOnPhone:value.phone,initialPosition:value.position,showClose:true)}
            .task(id:"\(selectedSeason.map(String.init) ?? "default"):\(retry)"){await loadDetails()}
    }
    private var playbackArea:some View {VStack(alignment:.leading,spacing:16){
        HStack{Text("PLAYBACK").font(.caption2.weight(.semibold)).tracking(1.5).foregroundStyle(.secondary);Spacer();
            Menu{Button{destination="mac"}label:{Label("Mac",systemImage:"desktopcomputer")};if directPhone{Button{destination="phone"}label:{Label("This iPhone",systemImage:"iphone")}}}label:{HStack(spacing:7){Image(systemName:destination=="phone" ? "iphone":"desktopcomputer");Text(destination=="phone" ? "This iPhone":"Mac");Image(systemName:"chevron.down").font(.caption2.weight(.bold))}.font(.subheadline.weight(.semibold)).frame(minHeight:44).padding(.horizontal,12).background(.white.opacity(0.06),in:.capsule)}.accessibilityLabel("Playback destination").accessibilityIdentifier("detail.destination").disabled(busy)
        }
        if item.kind != "movie"{episodeSelection}
        if let episodeLabel{Text(episodeLabel).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)}
        Button{play()}label:{HStack(spacing:12){if busy{ProgressView().tint(FlyxTheme.ink)}else{Image(systemName:"play.fill").font(.system(size:21,weight:.semibold))};Text(busy ? "Preparing…":playLabel).font(.headline);Spacer()}.foregroundStyle(FlyxTheme.ink).padding(.horizontal,20).frame(maxWidth:.infinity,minHeight:58).background(FlyxTheme.accent,in:.rect(cornerRadius:16)).contentShape(.rect(cornerRadius:16))}.buttonStyle(.plain).disabled(busy || loadingDetails || (item.kind != "movie" && episode==nil)).accessibilityLabel("\(playLabel) \(episodeLabel ?? item.title) on \(destination=="phone" ? "this iPhone":"Mac")").accessibilityIdentifier("detail.play")
        if progressSupported,savedProgress != nil{Button("Start over"){startOver=true;if item.kind != "movie"{selectedEpisode=episodes.first(where:{$0.number==savedProgress?.episode})?.number ?? episodes.first?.number}}.font(.subheadline).frame(minHeight:44).disabled(busy)}
        if let warning=details?.seasonError{Text(warning).font(.footnote).foregroundStyle(.orange);Button("Retry episodes"){retry+=1}}
        if item.kind != "movie",episodes.isEmpty{Text("No episodes are available from this provider yet.").font(.footnote).foregroundStyle(.secondary)}
        if client.scopes.contains("downloads.write"){Menu{Button("Best available"){download(quality:nil)};ForEach(["480p","720p","1080p","2160p"],id:\.self){quality in Button(quality){download(quality:quality)}}}label:{Label("Download on Mac",systemImage:"arrow.down.circle").frame(minHeight:44)}.disabled(busy || (item.kind != "movie" && episode==nil))}
    }.padding(18).background(FlyxTheme.card,in:.rect(cornerRadius:22)).overlay{RoundedRectangle(cornerRadius:22).stroke(.white.opacity(0.07))}}
    @ViewBuilder private var episodeSelection:some View {
        if item.kind=="tv",let seasons=details?.seasons,!seasons.isEmpty{Picker("Season",selection:Binding(get:{activeSeason ?? 0},set:{selectedSeason=$0;selectedEpisode=nil})){ForEach(seasons,id:\.number){season in Text(season.number==0 ? "Specials":"Season \(season.number)").tag(season.number)}}.tint(FlyxTheme.accent).disabled(busy)}
        if !episodes.isEmpty{Picker("Episode",selection:Binding(get:{episode ?? 1},set:{selectedEpisode=$0})){ForEach(episodes){episode in Text("\(episode.number). \(episode.title)").tag(episode.number)}}.tint(FlyxTheme.accent).disabled(busy || loadingDetails)}
    }
    private func loadDetails()async {
        struct Features:Decodable{var features:[String]?}
        let season=selectedSeason;loadingDetails=true;error=nil
        if let info:Features=try? await client.request("/remote/v1/info"){directPhone=info.features?.contains(where:{$0=="phone.direct.mp4" || $0=="phone.direct.hls"})==true;progressSupported=info.features?.contains("player.progress.v1")==true}
        do{let value=try await client.details(item,season:season);try Task.checkCancellation();guard season==selectedSeason else{return};details=value;loadingDetails=false
            if item.kind != "manga",progressSupported,!progressLoaded,let id=Int(item.id){progressLoaded=true;let reply:ProgressReply=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"read",selection:.init(kind:item.kind,contentID:id,season:item.kind=="movie" ? nil:1,episode:item.kind=="movie" ? nil:1))));savedProgress=reply.entry
                };applySavedSelection()

}catch is CancellationError{}catch{if !Task.isCancelled,season==selectedSeason{loadingDetails=false;self.error=error.localizedDescription}}
    }
    private func applySavedSelection(){guard !progressApplied,let entry=savedProgress,item.kind != "movie"else{return};if item.kind=="tv",activeSeason != entry.season,details?.seasons.contains(where:{$0.number==entry.season})==true{selectedSeason=entry.season;return};progressApplied=true
        if entry.completed{if let next=episodes.first(where:{$0.number>entry.episode}){selectedEpisode=next.number}else if item.kind=="tv",let next=details?.seasons.filter({$0.number>entry.season}).min(by:{$0.number<$1.number}){selectedSeason=next.number;selectedEpisode=nil}}else{selectedEpisode=entry.episode}
    }
    private func play(){guard !busy,!loadingDetails,let id=Int(item.id)else{return};let season=item.kind=="movie" ? nil:(item.kind=="anime" ? 1:activeSeason),episode=item.kind=="movie" ? nil:episode
        if destination=="phone"{playerPresentation = .init(selection:.init(kind:item.kind,contentID:id,season:season,episode:episode),phone:true,position:resumePosition);return}
        busy=true;error=nil;Task{defer{busy=false};do{let result=try await client.play(item,season:season,episode:episode,seconds:progressSupported ? resumePosition:nil);guard result.ok,result.status.state=="playing"else{throw RemoteFailure(message:"Mac did not confirm playback.")};playerPresentation = .init(selection:.init(kind:item.kind,contentID:id,season:season,episode:episode),phone:false,position:resumePosition)}catch{self.error=error.localizedDescription}}
    }
    private func download(quality:String?){busy=true;error=nil;Task{defer{busy=false};do{let result=try await client.download(item,season:item.kind=="movie" ? nil:activeSeason,episode:episode,quality:quality);message=result.ok ? "Queued on Mac":"Download was not queued"}catch{self.error=error.localizedDescription}}}
}
private struct DetailEpisode:Identifiable{var id:Int{number};let number:Int;let title:String}
private struct TitleFacts:View {
    let item:RemoteTitle;let details:RemoteDetails?
    var body:some View{HStack(spacing:12){if let date=details?.releaseDate ?? item.releaseDate,!date.isEmpty{Text(String(date.prefix(4)))};if let rating=details?.rating ?? item.rating,rating>0{Label(rating.formatted(.number.precision(.fractionLength(1))),systemImage:"star.fill")};if let votes=details?.voteCount ?? item.voteCount{Text("\(votes.formatted(.number.notation(.compactName))) ratings")}}.font(.caption.weight(.medium)).foregroundStyle(.secondary)}
}
struct TitleInformation:View {
    let rows:[RemoteDetails.Metadata]
    var body:some View{VStack(alignment:.leading,spacing:14){Text("Title information").font(.title3.bold());VStack(spacing:0){ForEach(rows){entry in VStack(alignment:.leading,spacing:6){Text(entry.label).font(.caption).foregroundStyle(.secondary);Text(entry.value).font(.subheadline.weight(.medium)).fixedSize(horizontal:false,vertical:true).textSelection(.enabled)}.frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,14).padding(.horizontal,18).overlay(alignment:.bottom){if entry.id != rows.last?.id{Divider().padding(.horizontal,18)}}}}.background(FlyxTheme.card,in:.rect(cornerRadius:20))}.accessibilityIdentifier("detail.title-information")}
}
private struct MangaChapterSection:View {
    let client:RemoteClient;let item:RemoteTitle;let chapters:[RemoteDetails.Chapter]
    var body:some View{if !chapters.isEmpty{VStack(alignment:.leading,spacing:16){NavigationLink("Read / Continue",destination:MangaReader(client:client,item:item,chapters:chapters)).buttonStyle(.borderedProminent).foregroundStyle(FlyxTheme.ink);DisclosureGroup("Chapters (\(chapters.count))"){ForEach(chapters){chapter in NavigationLink("\(chapter.number.formatted()). \(chapter.title)",destination:MangaReader(client:client,item:item,chapters:chapters,startingChapter:chapter.id))}}}}else{Text("No chapters are available from this provider yet.").foregroundStyle(.secondary)}}
}
