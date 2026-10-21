import SwiftUI
import WebKit

struct RemoteDetailView:View {
    private let suppliedClient:RemoteClient
    @Environment(\.applicationMode) private var applicationMode
    private var client:RemoteClient{applicationMode?.activeClient ?? suppliedClient}
    init(client:RemoteClient,item:RemoteTitle,watchlist:RemoteWatchlist?=nil){suppliedClient=client;self.item=item;self.watchlist=watchlist}
    let item:RemoteTitle
    var watchlist:RemoteWatchlist?=nil
    @State private var details:RemoteDetails?
    @State private var directPhone=false
    @State private var destination="mac"
    @State private var initialStandaloneDestination=false
    @Environment(\.playbackSession) private var sharedSession
    @State private var localSession=PlaybackSession()
    @State private var castPresented=false
    @State private var selectedReceiver:RemoteCastDevice?
    @State private var downloadState:RemoteDownload?
    @State private var checkedDownloadKey=""
    @State private var checkingDownload=true
    @State private var downloadCheckFailed=false
    @State private var downloadStateSupported=false
    private var session:PlaybackSession{sharedSession ?? localSession}
    private var destinationLabel:String{destination=="phone" ? "This iPhone":destination=="tv" ? selectedReceiver?.name ?? "TV":"Mac"}
    private var downloadSelection:PhonePlaybackSelection?{guard let id=Int(item.id),item.kind != "manga",item.kind=="movie" || episode != nil else{return nil};return .init(kind:item.kind,contentID:id,season:item.kind=="movie" ? nil:(item.kind=="anime" ? 1:activeSeason),episode:item.kind=="movie" ? nil:episode)}
    private var downloadKey:String{(downloadSelection?.id ?? "none")+String(downloadStateSupported)}
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
            if item.kind != "manga",details != nil || loadingDetails{playbackArea.redacted(reason:loadingDetails ? .placeholder:[]).loadingShimmer(loadingDetails).allowsHitTesting(!loadingDetails).accessibilityHidden(loadingDetails)}
            else if let details,item.kind=="manga"{MangaChapterSection(client:client,item:item,chapters:details.chapters ?? [],emptyReason:details.chapterUnavailable)}
            if let watchlist{HStack(spacing:10){WatchlistSaveButton(item:item,model:watchlist,client:client);Text(watchlist.contains(item) ? "Saved to watchlist":"Save to watchlist").font(.subheadline)};if !watchlist.canWrite{Text("Allow watchlist saving in Flyx on Mac.").font(.caption).foregroundStyle(.secondary)}}
            let overview=details?.overview ?? item.overview
            if !overview.isEmpty{VStack(alignment:.leading,spacing:10){Text("Overview").font(.headline);Text(overview).font(.body).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)}}
            if item.kind=="movie",let trailer=details?.trailer{MovieTrailerSection(trailer:trailer)}
            if let metadata=details?.metadata,!metadata.isEmpty{TitleInformation(rows:metadata)}
            if loadingDetails{ProgressView(item.kind=="manga" ? "Loading chapters…":"Loading title information…").frame(minHeight:44).frame(maxWidth:.infinity,alignment:.leading)}
            if let message{Text(message).font(.footnote).foregroundStyle(FlyxTheme.accent)}
            if let error{VStack(alignment:.leading,spacing:8){Text(error).font(.footnote).foregroundStyle(.orange);Button("Retry details"){retry+=1}}}
            if item.kind=="movie" || item.kind=="tv"{AudienceReviewsSection(client:client,item:item).id(item.stableID)}
        }.padding(24)}.background(.black).navigationBarTitleDisplayMode(.inline)
            #if DEBUG
            .defaultScrollAnchor(ProcessInfo.processInfo.arguments.contains("details-reviews50") ? .bottom:.top)
            #endif
            .fullScreenCover(item:$playerPresentation){value in RemoteControlView(client:session.controlClient ?? client,initialSelection:value.selection,initialItem:item,startsOnPhone:value.phone,initialPosition:value.position,initialPresentationID:value.id,showClose:true).environment(\.playbackSession,session)}
            .task(id:"\(client.baseURL):\(selectedSeason.map(String.init) ?? "default"):\(retry)"){if client.isStandalone{destination="phone";selectedReceiver=nil;initialStandaloneDestination=true};await loadDetails()}
            .task(id:"\(client.baseURL):\(downloadKey)"){while !Task.isCancelled{await refreshDownloadState();do{try await Task.sleep(for:.seconds(5))}catch{return}}}
            .sheet(isPresented:$castPresented){CastReceiverPicker(client:client){receiver in selectedReceiver=receiver;destination="tv"}}

    }
    private var playbackArea:some View {VStack(alignment:.leading,spacing:16){
        HStack{Text("PLAYBACK").font(.caption2.weight(.semibold)).tracking(1.5).foregroundStyle(.secondary);Spacer();
            Menu{if !client.isStandalone{Button{destination="mac"}label:{Label("Mac",systemImage:"desktopcomputer")}};if directPhone{Button{destination="phone"}label:{Label("This iPhone",systemImage:"iphone")}};if !client.isStandalone{Button{castPresented=true}label:{Label("Cast to TV",systemImage:"tv")}}}label:{HStack(spacing:7){Image(systemName:destination=="phone" ? "iphone":destination=="tv" ? "tv":"desktopcomputer");Text(destinationLabel).lineLimit(1);Image(systemName:"chevron.down").font(.caption2.weight(.bold))}.font(.subheadline.weight(.semibold)).frame(minHeight:44).padding(.horizontal,12).background(.white.opacity(0.06),in:.capsule)}.accessibilityLabel("Playback destination").accessibilityIdentifier("detail.destination").disabled(busy)
        }
        if item.kind != "movie"{episodeSelection}
        if let episodeLabel{Text(episodeLabel).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)}
        Button{play()}label:{HStack(spacing:12){if busy{ProgressView().tint(FlyxTheme.ink)}else{Image(systemName:"play.fill").font(.system(size:21,weight:.semibold))};Text(busy ? "Preparing…":playLabel).font(.headline);Spacer()}.foregroundStyle(FlyxTheme.ink).padding(.horizontal,20).frame(maxWidth:.infinity,minHeight:58).background(FlyxTheme.accent,in:.rect(cornerRadius:16)).contentShape(.rect(cornerRadius:16))}.buttonStyle(.plain).disabled(busy || loadingDetails || (client.isStandalone && details?.playbackUnavailable != nil) || (item.kind != "movie" && episode==nil)).accessibilityLabel("\(playLabel) \(episodeLabel ?? item.title) on \(destinationLabel)").accessibilityIdentifier("detail.play")
        if client.isStandalone,let unavailable=details?.playbackUnavailable{Text(unavailable).font(.footnote).foregroundStyle(.secondary)}
        if progressSupported,savedProgress != nil{Button("Start over"){startOver=true;if item.kind != "movie"{selectedEpisode=episodes.first(where:{$0.number==savedProgress?.episode})?.number ?? episodes.first?.number}}.font(.subheadline).frame(minHeight:44).disabled(busy)}
        if let warning=details?.seasonError{Text(warning).font(.footnote).foregroundStyle(.orange);Button("Retry episodes"){retry+=1}}
        if item.kind != "movie",episodes.isEmpty,!loadingDetails{Text("No episodes are available from this provider yet.").font(.footnote).foregroundStyle(.secondary)}
        if client.scopes.contains("downloads.write"){downloadControl.frame(minHeight:44,alignment:.leading)}
    }.padding(18).background(FlyxTheme.card,in:.rect(cornerRadius:22)).overlay{RoundedRectangle(cornerRadius:22).stroke(.white.opacity(0.07))}}
    @ViewBuilder private var downloadControl:some View {
        if checkingDownload{Label("Checking download…",systemImage:"arrow.down.circle").font(.subheadline).foregroundStyle(.secondary)}
        else if !downloadStateSupported{Text("Update Flyx on Mac to check existing downloads.").font(.caption).foregroundStyle(.secondary)}
        else if downloadCheckFailed{Button("Check download status"){Task{await refreshDownloadState()}}}
        else if let job=downloadState,job.active || job.playable{Label(job.playable ? "Downloaded on Mac":job.stateLabel,systemImage:job.playable ? "checkmark.circle.fill":"arrow.down.circle").font(.subheadline).foregroundStyle(job.playable ? FlyxTheme.accent:.secondary)}
        else{Menu{Button("Best available"){download(quality:nil)};ForEach(["480p","720p","1080p","2160p"],id:\.self){quality in Button(quality){download(quality:quality)}}}label:{Label(downloadState==nil ? "Download on Mac":"Retry download on Mac",systemImage:"arrow.down.circle").frame(minHeight:44)}.disabled(busy || loadingDetails || (item.kind != "movie" && episode==nil))}
    }
    private func refreshDownloadState()async{
        guard downloadStateSupported,client.scopes.contains("downloads.read"),let selection=downloadSelection else{checkingDownload=false;downloadState=nil;return}
        let key=downloadKey
        if key != checkedDownloadKey{checkingDownload=true;downloadState=nil;downloadCheckFailed=false}
        do{let value:RemoteDownloadList=try await client.request("/remote/v1/downloads");try Task.checkCancellation();guard key==downloadKey else{return};downloadState=value.jobs.first{$0.selection?.id==selection.id && ($0.active || $0.playable)} ?? value.jobs.first{$0.selection?.id==selection.id};checkedDownloadKey=key;checkingDownload=false;downloadCheckFailed=false}
        catch{if !Task.isCancelled,key==downloadKey{checkedDownloadKey=key;checkingDownload=false;downloadCheckFailed=true}}
    }
    @ViewBuilder private var episodeSelection:some View {
        if item.kind=="tv",let seasons=details?.seasons,!seasons.isEmpty{Picker("Season",selection:Binding(get:{activeSeason ?? 0},set:{selectedSeason=$0;selectedEpisode=nil})){ForEach(seasons,id:\.number){season in Text(season.number==0 ? "Specials":"Season \(season.number)").tag(season.number)}}.tint(FlyxTheme.accent).disabled(busy)}
        if !episodes.isEmpty{Picker("Episode",selection:Binding(get:{episode ?? 1},set:{selectedEpisode=$0})){ForEach(episodes){episode in Text("\(episode.number). \(episode.title)").tag(episode.number)}}.tint(FlyxTheme.accent).disabled(busy || loadingDetails)}
    }
    private func loadDetails()async {
        struct Features:Decodable{var features:[String]?}
        let season=selectedSeason;loadingDetails=true;error=nil
        if let info:Features=try? await client.request("/remote/v1/info"){downloadStateSupported=info.features?.contains("downloads.library.v1")==true;directPhone=info.features?.contains(where:{$0=="phone.direct.mp4" || $0=="phone.direct.hls"})==true;progressSupported=info.features?.contains("player.progress.v1")==true}
        do{let value=try await client.details(item,season:season);try Task.checkCancellation();guard season==selectedSeason else{return};details=value;loadingDetails=false
            if item.kind != "manga",progressSupported,!progressLoaded,let id=Int(item.id){progressLoaded=true;let reply:ProgressReply=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"read",selection:.init(kind:item.kind,contentID:id,season:item.kind=="movie" ? nil:1,episode:item.kind=="movie" ? nil:1))));savedProgress=reply.entry
                };applySavedSelection()

}catch is CancellationError{}catch{if !Task.isCancelled,season==selectedSeason{loadingDetails=false;self.error=error.localizedDescription}}
    }
    private func applySavedSelection(){guard !progressApplied,let entry=savedProgress,item.kind != "movie"else{return};if item.kind=="tv",activeSeason != entry.season,details?.seasons.contains(where:{$0.number==entry.season})==true{selectedSeason=entry.season;return};progressApplied=true
        if entry.completed{if let next=episodes.first(where:{$0.number>entry.episode}){selectedEpisode=next.number}else if item.kind=="tv",let next=details?.seasons.filter({$0.number>entry.season}).min(by:{$0.number<$1.number}){selectedSeason=next.number;selectedEpisode=nil}}else{selectedEpisode=entry.episode}
    }
    private func play(){guard !busy,!session.busy,!loadingDetails,let id=Int(item.id)else{return};let season=item.kind=="movie" ? nil:(item.kind=="anime" ? 1:activeSeason),episode=item.kind=="movie" ? nil:episode
        if destination=="phone"{let value=PlayerPresentation(selection:.init(kind:item.kind,contentID:id,season:season,episode:episode),phone:true,position:resumePosition);session.startPhone(client,presentationID:value.id,selection:value.selection,position:value.position,item:item);playerPresentation=value;return}
        busy=true;error=nil;session.run{defer{busy=false};do{let result=try await client.play(item,season:season,episode:episode,seconds:progressSupported ? resumePosition:nil);try Task.checkCancellation();guard result.ok,result.status.state=="playing"else{throw RemoteFailure(message:"Mac did not confirm playback.")};session.status=result.status;session.controlClient=client;session.phoneActive=false;if destination=="tv"{guard let receiver=selectedReceiver else{throw RemoteFailure(message:"Choose a TV first.")};try Task.checkCancellation();try await session.switchOutput(client,to:"tv",receiverID:receiver.id);if sharedSession != nil{return}};playerPresentation = .init(selection:.init(kind:item.kind,contentID:id,season:season,episode:episode),phone:false,position:resumePosition)}catch{if !Task.isCancelled{self.error=error.localizedDescription}}}
    }

    private func download(quality:String?){guard !busy,downloadStateSupported,!checkingDownload,!downloadCheckFailed,downloadState?.active != true,downloadState?.playable != true else{return};busy=true;error=nil;Task{defer{busy=false};do{let result=try await client.download(item,season:item.kind=="movie" ? nil:activeSeason,episode:episode,quality:quality);await refreshDownloadState();message=result.ok ? nil:"Download was not queued"}catch{self.error=error.localizedDescription}}}
}
private struct DetailEpisode:Identifiable{var id:Int{number};let number:Int;let title:String}
private struct TitleFacts:View {
    let item:RemoteTitle;let details:RemoteDetails?
    var body:some View{HStack(spacing:12){if let date=details?.releaseDate ?? item.releaseDate,!date.isEmpty{Text(String(date.prefix(4)))};if let rating=details?.rating ?? item.rating,rating>0{Label(rating.formatted(.number.precision(.fractionLength(1))),systemImage:"star.fill")};if let votes=details?.voteCount ?? item.voteCount{Text("\(votes.formatted(.number.notation(.compactName))) ratings")}}.font(.caption.weight(.medium)).foregroundStyle(.secondary)}
}
struct TitleInformation:View {
    let rows:[RemoteDetails.Metadata]
    var body:some View{VStack(alignment:.leading,spacing:14){Text("Title information").font(.title3.bold());VStack(spacing:0){ForEach(rows){entry in VStack(alignment:.leading,spacing:6){Text(entry.label).font(.caption).foregroundStyle(.secondary);Group{if let raw=entry.url,let url=URL(string:raw),url.scheme=="https"{Link(entry.value,destination:url)}else{Text(entry.value).textSelection(.enabled)}}.font(.subheadline.weight(.medium)).fixedSize(horizontal:false,vertical:true)}.frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,14).padding(.horizontal,18).overlay(alignment:.bottom){if entry.id != rows.last?.id{Divider().padding(.horizontal,18)}}}}.background(FlyxTheme.card,in:.rect(cornerRadius:20))}.accessibilityIdentifier("detail.title-information")}
}
private struct MangaChapterSection:View {
    let client:RemoteClient;let item:RemoteTitle;let chapters:[RemoteDetails.Chapter];var emptyReason:String?=nil
    var body:some View{if !chapters.isEmpty{VStack(alignment:.leading,spacing:16){NavigationLink("Read / Continue",destination:MangaReader(client:client,item:item,chapters:chapters)).buttonStyle(.borderedProminent).foregroundStyle(FlyxTheme.ink);DisclosureGroup("Chapters (\(chapters.count))"){ForEach(chapters){chapter in NavigationLink("\(chapter.number.formatted()). \(chapter.title)",destination:MangaReader(client:client,item:item,chapters:chapters,startingChapter:chapter.id))}}}}else{Text(emptyReason ?? "This provider currently lists no chapters for this title.").foregroundStyle(.secondary)}}
}


/// Independent of the movie output selector. Only the official YouTube player handles media.
private struct MovieTrailerSection:View {
    let trailer:RemoteDetails.Trailer
    @State private var opened=false
    @State private var failed=false
    private var valid:Bool{trailer.videoID.range(of:"^[A-Za-z0-9_-]{11}$",options:.regularExpression) != nil}
    private var watchURL:URL{URL(string:"https://www.youtube.com/watch?v=\(trailer.videoID)")!}
    var body:some View {if valid{VStack(alignment:.leading,spacing:12){
        Text("Trailer").font(.headline)
        if opened && !failed{YouTubeTrailerPlayer(videoID:trailer.videoID,failed:$failed).frame(minHeight:220).aspectRatio(16/9,contentMode:.fit)}
        else if !failed{TrailerPreviewCard(videoID:trailer.videoID){opened=true}}
        if failed{Text("This trailer could not play here.").font(.subheadline).foregroundStyle(.secondary);Link("Open in YouTube",destination:watchURL).font(.subheadline)}
    }}}
}
private struct TrailerPreviewCard:View {
    let videoID:String
    let play:()->Void
    var body:some View {Button(action:play){ZStack{
        GeometryReader{geometry in artwork.frame(width:geometry.size.width,height:geometry.size.height).clipped()}
        playGlyph
    }.aspectRatio(16/9,contentMode:.fit).background(.black).clipShape(.rect(cornerRadius:24))}
        .buttonStyle(.plain).accessibilityLabel("Play trailer")}
    @ViewBuilder private var artwork:some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("trailer-glass49"){
            ZStack{LinearGradient(colors:[.indigo,.orange,.teal],startPoint:.topLeading,endPoint:.bottomTrailing);Circle().fill(.white.opacity(0.5)).frame(width:90,height:90).offset(x:90,y:-40);Rectangle().fill(.black.opacity(0.4)).rotationEffect(.degrees(-25)).offset(y:100)}
        }else{thumbnail}
        #else
        thumbnail
        #endif
    }
    private var thumbnail:some View {AsyncImage(url:URL(string:"https://i.ytimg.com/vi/\(videoID)/hqdefault.jpg")){image in image.resizable().scaledToFill()}placeholder:{Rectangle().fill(.quaternary)}}
    private var glyph:some View {Image(systemName:"play.fill").font(.system(size:25,weight:.semibold)).foregroundStyle(.white).offset(x:2).frame(width:64,height:64)}
    @ViewBuilder private var playGlyph:some View {
        if #available(iOS 26,*){glyph.glassEffect(.regular.tint(.black.opacity(0.2)).interactive(),in:.circle)}
        else{glyph.background(.ultraThinMaterial,in:.circle).overlay{Circle().strokeBorder(.white.opacity(0.3),lineWidth:0.75)}}
    }
}
#if DEBUG
struct TrailerPreviewFixture:View {
    var body:some View {ScrollView{VStack(alignment:.leading,spacing:24){Text("Overview").font(.headline);Text("A synthetic scene for previewing the trailer card.").foregroundStyle(.secondary);MovieTrailerSection(trailer:.init(videoID:"AAAAAAAAAAA",title:"Synthetic trailer"))}.padding(24)}.background(.black)}
}
#endif
private struct YouTubeTrailerPlayer:UIViewRepresentable {
    let videoID:String
    @Binding var failed:Bool
    func makeCoordinator()->Coordinator{Coordinator(failed:$failed)}
    func makeUIView(context:Context)->WKWebView{
        let configuration=WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback=true
        configuration.allowsAirPlayForMediaPlayback=false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.userContentController.add(context.coordinator,name:"trailerError")
        let web=WKWebView(frame:.zero,configuration:configuration)
        web.navigationDelegate=context.coordinator
        let identity="https://"+(Bundle.main.bundleIdentifier ?? "local.flyx.remote").lowercased()
        let html="""
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin-when-cross-origin"><style>html,body,#player{margin:0;width:100%;height:100%;background:#000}</style></head><body><div id="player"></div><script src="https://www.youtube.com/iframe_api"></script><script>function onYouTubeIframeAPIReady(){new YT.Player('player',{videoId:'\(videoID)',playerVars:{autoplay:0,playsinline:1,controls:1,origin:'\(identity)'},events:{onError:function(){window.webkit.messageHandlers.trailerError.postMessage('failed')}}});}</script></body></html>
        """
        web.loadHTMLString(html,baseURL:URL(string:identity))
        return web
    }
    func updateUIView(_ uiView:WKWebView,context:Context){}
    static func dismantleUIView(_ uiView:WKWebView,coordinator:Coordinator){uiView.stopLoading();uiView.configuration.userContentController.removeScriptMessageHandler(forName:"trailerError");uiView.navigationDelegate=nil;uiView.loadHTMLString("",baseURL:nil)}
    final class Coordinator:NSObject,WKNavigationDelegate,WKScriptMessageHandler{
        private var failed:Binding<Bool>
        init(failed:Binding<Bool>){self.failed=failed}
        func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){failed.wrappedValue=true}
        func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){failed.wrappedValue=true}
        func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){failed.wrappedValue=true}
    }
}

private struct AudienceReview:Decodable,Identifiable,Sendable {
    let id:String;let author:String;let text:String;let rating:Double?;let createdAt:String?;let url:String
    var originalURL:URL?{guard let value=URL(string:url),value.scheme=="https",value.host=="www.themoviedb.org",value.path=="/review/"+id,value.user==nil,value.password==nil else{return nil};return value}
    var date:Date?{guard let createdAt else{return nil};return (try? Date.ISO8601FormatStyle(includingFractionalSeconds:true).parse(createdAt)) ?? (try? Date.ISO8601FormatStyle().parse(createdAt))}
}
private struct AudienceReviewPage:Decodable {let items:[AudienceReview];let order:String;let page:Int;let nextPage:Int?;let total:Int?}
private struct AudienceReviewsSection:View {
    let client:RemoteClient;let item:RemoteTitle
    @State private var reviews:[AudienceReview]=[]
    @State private var nextPage:Int?=1
    @State private var loading=false
    @State private var error:String?
    @State private var credits=false
    var body:some View {VStack(alignment:.leading,spacing:0){if !reviews.isEmpty || loading || error != nil{VStack(alignment:.leading,spacing:14){
        HStack{Text("Audience reviews").font(.title3.bold());Spacer();Image("TMDBLogo").resizable().scaledToFit().frame(width:54,height:22).accessibilityLabel("TMDB")}
        Text("TMDB order").font(.caption).foregroundStyle(.secondary)
        LazyVStack(spacing:12){ForEach(reviews){review in AudienceReviewCard(review:review)}}
        if loading{ProgressView("Loading reviews…").font(.caption).frame(maxWidth:.infinity)}
        if let error{Text(error).font(.footnote).foregroundStyle(.secondary);Button("Retry reviews"){Task{await load()}}.disabled(loading)}
        else if !reviews.isEmpty,nextPage != nil{Button("Load more reviews"){Task{await load()}}.frame(minHeight:44).disabled(loading)}
        Button("TMDB credits"){credits=true}.font(.caption).foregroundStyle(.secondary)
    }}}
    .task{
        struct Features:Decodable{let features:[String]?}
        do{let info:Features=try await client.request("/remote/v1/info");try Task.checkCancellation();if info.features?.contains("catalog.reviews.v1")==true{await load()}}catch{}
    }
    .sheet(isPresented:$credits){NavigationStack{VStack(alignment:.leading,spacing:20){Image("TMDBLogo").resizable().scaledToFit().frame(width:120,height:50).accessibilityLabel("TMDB");Text("This product uses the TMDB API but is not endorsed or certified by TMDB.");Link("TMDB",destination:URL(string:"https://www.themoviedb.org")!);Spacer()}.padding(24).navigationTitle("Credits").navigationBarTitleDisplayMode(.inline)}.presentationDetents([.medium]).presentationDragIndicator(.visible)}
    }
    private func load()async{
        guard !loading,let page=nextPage else{return};loading=true;error=nil;defer{loading=false}
        do{
            let result:AudienceReviewPage=try await client.request("/remote/v1/reviews",query:[.init(name:"kind",value:item.kind),.init(name:"id",value:item.id),.init(name:"page",value:String(page))]);try Task.checkCancellation()
            guard result.page==page,result.order=="tmdb" else{throw RemoteFailure(message:"Reviews unavailable")}
            var seen=Set(reviews.map(\.id));reviews.append(contentsOf:result.items.filter{seen.insert($0.id).inserted});nextPage=result.nextPage
        }catch is CancellationError{}catch{if !Task.isCancelled{self.error="Reviews are temporarily unavailable."}}
    }
}
private struct AudienceReviewCard:View {
    let review:AudienceReview
    @State private var expanded=false
    private var compact:String{review.text.replacingOccurrences(of:"\\s+",with:" ",options:.regularExpression)}
    private var preview:String{String(compact.prefix(320))+(compact.count>320 ? "…":"")}
    var body:some View {VStack(alignment:.leading,spacing:10){
        HStack(alignment:.top){VStack(alignment:.leading,spacing:4){Text(verbatim:review.author).font(.subheadline.bold()).lineLimit(2);if let date=review.date{Text(date,format:.dateTime.day().month(.abbreviated).year()).font(.caption).foregroundStyle(.secondary)}};Spacer(minLength:8);if let rating=review.rating{HStack(spacing:4){Image(systemName:"star.fill");Text(rating.formatted(.number.precision(.fractionLength(1)))+"/10")}.font(.caption.weight(.semibold)).foregroundStyle(FlyxTheme.accent).fixedSize()}}
        Text(verbatim:expanded ? review.text:preview).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true).textSelection(.enabled)
        HStack{if compact.count>320{Button(expanded ? "Show less":"Read more"){expanded.toggle()}};Spacer();if let url=review.originalURL{Link("Original review",destination:url)}}.font(.caption.weight(.semibold)).frame(minHeight:32)
    }.padding(16).frame(maxWidth:.infinity,alignment:.leading).background(FlyxTheme.card,in:.rect(cornerRadius:18))}
}
