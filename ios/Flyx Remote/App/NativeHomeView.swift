import SwiftUI
import Observation

enum HomeLayout {static let inset:CGFloat=20;static let sectionSpacing:CGFloat=28;static let railSpacing:CGFloat=14;static let posterWidth:CGFloat=148;static let posterHeight:CGFloat=222;static let featuredHeight:CGFloat=360}


struct HomeFeedEntry:Decodable,Identifiable,Sendable {
    let id:String
    let title:RemoteTitle
    var rank:Int?
}
struct HomeFeedSection:Decodable,Identifiable,Sendable {
    let id:String
    let kind:String
    let title:String
    let subtitle:String
    let source:String
    let ranked:Bool
    let items:[HomeFeedEntry]
    let stale:Bool
    var updatedAt:Double?
    var error:String?
}
struct HomeFeedResponse:Decodable,Sendable {
    let sections:[HomeFeedSection]
    let checkedAt:Double
    let cached:Bool
}

@MainActor @Observable final class NativeHomeFeed {
    private(set) var sections:[HomeFeedSection]=[]
    private(set) var loading=false
    private(set) var error:String?
    private(set) var requiresUpdate=false
    private(set) var checkedAt:Date?
    private var category="all"
    private var generation=UUID()
    private var cached:[String:HomeFeedResponse]=[:]
    func represents(_ value:String)->Bool{category==value}
    func visibleSections(for value:String)->[HomeFeedSection]{let source=category==value ? sections:(cached[value]?.sections ?? []);return source.filter{value=="all" || $0.kind==value}}
    func load(_ client:RemoteClient,category:String="all",refresh:Bool=false)async {
        if self.category != category {
            self.category=category;generation=UUID();loading=false;error=nil
            sections=cached[category]?.sections ?? []
            checkedAt=cached[category].map{Date(timeIntervalSince1970:$0.checkedAt/1000)}
        }
        guard !loading,refresh || (checkedAt.map({Date().timeIntervalSince($0)>180}) ?? true) else{return}
        let ticket=generation;loading=true;defer{if generation==ticket{loading=false}}
        do {
            struct Features:Decodable {var features:[String]?}
            let info:Features=try await client.request("/remote/v1/info")
            try Task.checkCancellation();guard generation==ticket else{return}
            guard info.features?.contains("catalog.home.v1")==true,(category=="all" || info.features?.contains("catalog.home.categories.v1")==true) else {
                requiresUpdate=true;error="Update Flyx on your Mac to load these Home sections. Browse is still available.";return
            }
            var query:[URLQueryItem]=[]
            if category != "all"{query.append(.init(name:"category",value:category))}
            if refresh{query.append(.init(name:"refresh",value:"1"))}
            let response:HomeFeedResponse=try await client.request("/remote/v1/home",query:query)
            try Task.checkCancellation();guard generation==ticket else{return}
            sections=response.sections;cached[category]=response;checkedAt=Date(timeIntervalSince1970:response.checkedAt/1000);requiresUpdate=false;error=nil
            await ConnectionVerification.shared.loadedHome(rows:Dictionary(uniqueKeysWithValues:response.sections.map{($0.id,$0.items.count)}),staleRows:response.sections.filter(\.stale).count)
        } catch is CancellationError { }
        catch {if !Task.isCancelled,generation==ticket{self.error=sections.isEmpty ? error.localizedDescription:"Could not refresh Home. Showing previously loaded titles."}}
    }
}

@MainActor struct NativeHomeView:View {
    let client:RemoteClient
    let watchlist:RemoteWatchlist
    @Environment(\.playbackSession) private var playback
    @Environment(\.scenePhase) private var scenePhase
    @State private var feed=NativeHomeFeed()
    @State private var path:[RemoteTitle]=[]
    @State private var category="all"
    private let categories=[("all","All"),("movie","Movies"),("tv","TV"),("anime","Anime"),("manga","Manga")]
    private var sections:[HomeFeedSection]{feed.visibleSections(for:category)}
    private var featured:HomeFeedEntry?{sections.lazy.flatMap(\.items).first}
    var body:some View {
        NavigationStack(path:$path){
            VStack(spacing:0){
                if path.isEmpty{header}
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:HomeLayout.sectionSpacing){
                        if sections.isEmpty && (!feed.represents(category) || (feed.error==nil && (feed.loading || feed.checkedAt==nil))) {HomeFeedSkeleton()}
                        else {
                            if let message=feed.error,feed.represents(category){status(message)}
                            if let featured{HomeFeaturedCard(entry:featured,client:client,watchlist:watchlist).padding(.horizontal,20)}
                            if !watchlist.items.isEmpty,category=="all" {
                                HomePosterRail(title:"Your watchlist",subtitle:"Saved on your Mac",entries:Array(watchlist.items.prefix(16)).map{HomeFeedEntry(id:$0.stableID,title:$0)},client:client,watchlist:watchlist)
                            }
                            ForEach(sections){section in
                                VStack(alignment:.leading,spacing:12){
                                    HomePosterRail(title:section.title,subtitle:section.subtitle,entries:section.items,client:client,watchlist:watchlist)
                                    if let message=section.error{Label(message,systemImage:section.stale ? "clock":"wifi.exclamationmark").font(.caption).foregroundStyle(.secondary).padding(.horizontal,20)}
                                    else if section.items.isEmpty{Text("No titles are available in this feed right now.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal,20)}
                                }
                            }
                            if feed.sections.isEmpty && feed.error==nil {
                                ContentUnavailableView("Home is quiet",systemImage:"house",description:Text("Pull down to refresh the Mac catalogue."))
                            }
                        }
                    }.padding(.top,12).padding(.bottom,28)
                }.refreshable{await feed.load(client,category:category,refresh:true)}
                #if DEBUG
                .defaultScrollAnchor(ProcessInfo.processInfo.arguments.contains("home-footer46") ? .bottom:.top)
                #endif
            }.background(FlyxTheme.background)
                .toolbar(path.isEmpty ? .hidden:.visible,for:.navigationBar)
                .navigationDestination(for:RemoteTitle.self){RemoteDetailView(client:client,item:$0,watchlist:watchlist)}
                .task(id:category){await feed.load(client,category:category)}
                .onChange(of:scenePhase){_,phase in if phase == .active,path.isEmpty{Task{await feed.load(client,category:category)}}}
        }
    }
    private var header:some View {
        VStack(alignment:.leading,spacing:10){
            HStack(spacing:10){
                Text("Flyx").font(.title2.bold()).foregroundStyle(FlyxTheme.accent)
                Text("Home").font(.title2.bold())
                Spacer(minLength:8)
                MacConnectionIndicator(client:client)
                Button{playback?.selectedTab="browse"}label:{Image(systemName:"magnifyingglass").font(.title3).frame(width:44,height:44).background(FlyxTheme.card,in:.circle)}.accessibilityLabel("Search and browse all titles")
            }.padding(.horizontal,20)
            ScrollView(.horizontal){HStack(spacing:8){ForEach(categories,id:\.0){choice in
                Button{category=choice.0}label:{Text(choice.1).font(.subheadline.weight(.semibold)).padding(.horizontal,17).frame(minHeight:44).foregroundStyle(category==choice.0 ? FlyxTheme.ink:.white).background(category==choice.0 ? FlyxTheme.accent:FlyxTheme.card,in:.capsule)}
                    .buttonStyle(.plain).accessibilityAddTraits(category==choice.0 ? .isSelected:[])
            }}.padding(.horizontal,20)}.scrollIndicators(.hidden)
        }.padding(.top,2).padding(.bottom,12).background(.black)
    }
    private func status(_ message:String)->some View {
        VStack(alignment:.leading,spacing:10){
            Label(message,systemImage:feed.requiresUpdate ? "desktopcomputer":"wifi.exclamationmark").font(.subheadline).foregroundStyle(.secondary)
            HStack{Button("Retry"){Task{await feed.load(client,category:category,refresh:true)}}.frame(minHeight:44).disabled(feed.loading);Spacer();Button("Open Browse"){playback?.selectedTab="browse"}.frame(minHeight:44)}
        }.padding(16).background(FlyxTheme.card,in:.rect(cornerRadius:16)).padding(.horizontal,20)
    }
}

private struct HomeFeaturedCard:View {
    let entry:HomeFeedEntry
    let client:RemoteClient
    let watchlist:RemoteWatchlist
    var body:some View {
        ZStack(alignment:.bottomLeading){
            HomeArtwork(item:entry.title,backdrop:true)
            LinearGradient(stops:[.init(color:.black.opacity(0.05),location:0),.init(color:.black.opacity(0.45),location:0.35),.init(color:.black,location:1)],startPoint:.top,endPoint:.bottom)
            VStack(alignment:.leading,spacing:10){
                Text("FEATURED · \(homeKind(entry.title.kind).uppercased())").font(.caption.weight(.bold)).tracking(1).foregroundStyle(FlyxTheme.accent)
                Text(entry.title.title).font(.title.bold()).lineLimit(2)
                HomeTitleMetadata(item:entry.title)
                if !entry.title.overview.isEmpty{Text(entry.title.overview).font(.subheadline).foregroundStyle(.white.opacity(0.8)).lineLimit(2)}
                NavigationLink(value:entry.title){Label(entry.title.kind=="manga" ? "Explore manga":"View details",systemImage:"arrow.up.right").font(.subheadline.bold()).padding(.horizontal,18).frame(minHeight:46).foregroundStyle(FlyxTheme.ink).background(FlyxTheme.accent,in:.capsule)}.buttonStyle(.plain)
            }.padding(20)
        }.frame(height:HomeLayout.featuredHeight).background(.black).compositingGroup()
            .clipShape(RoundedRectangle(cornerRadius:24,style:.continuous),style:FillStyle(antialiased:true))
            .overlay(alignment:.topTrailing){WatchlistSaveButton(item:entry.title,model:watchlist,client:client).padding(12)}
    }
}

private struct HomePosterRail:View {
    let title:String
    let subtitle:String
    let entries:[HomeFeedEntry]
    let client:RemoteClient
    let watchlist:RemoteWatchlist
    var body:some View {
        VStack(alignment:.leading,spacing:HomeLayout.railSpacing){
            HomeRailHeader(title:title,subtitle:subtitle)
            if !entries.isEmpty{ScrollView(.horizontal){LazyHStack(alignment:.top,spacing:HomeLayout.railSpacing){ForEach(entries){entry in
                ZStack(alignment:.topTrailing){
                    NavigationLink(value:entry.title){HomePosterCard(entry:entry)}.buttonStyle(.plain)
                    WatchlistSaveButton(item:entry.title,model:watchlist,client:client).padding(6)
                }.frame(width:HomeLayout.posterWidth)
            }}.scrollTargetLayout()}.contentMargins(.horizontal,HomeLayout.inset,for:.scrollContent).scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned)}
        }
    }
}

private struct HomePosterCard:View {
    let entry:HomeFeedEntry
    var body:some View {
        PosterCardSlots(posterHeight:HomeLayout.posterHeight,metadataHeight:16,titleHeight:42,cornerRadius:14,expandsMetadata:true){
            HomeArtwork(item:entry.title).overlay(alignment:.bottomLeading){if let rank=entry.rank{Text(rank.formatted()).font(.system(size:44,weight:.black,design:.rounded)).foregroundStyle(FlyxTheme.accent).padding(.horizontal,10).background(.black.opacity(0.78),in:.rect(cornerRadius:10)).padding(7)}}
        }metadata:{HomeTitleMetadata(item:entry.title)}title:{Text(entry.title.title).font(.subheadline.weight(.semibold)).lineLimit(2)
        }.accessibilityElement(children:.ignore).accessibilityLabel("\(entry.rank.map{"Rank \($0). "} ?? "")\(entry.title.title), \(homeKind(entry.title.kind))")
    }
}

private struct HomeTitleMetadata:View {
    let item:RemoteTitle
    private var year:String? {guard let date=item.releaseDate,date.count>=4 else{return nil};return String(date.prefix(4))}
    var body:some View {
        ViewThatFits(in:.horizontal){
            HStack(spacing:7){kind;if let year{Text(year).fixedSize()};rating}.fixedSize(horizontal:true,vertical:true)
            HStack(spacing:7){kind;rating}.fixedSize(horizontal:true,vertical:true)
            VStack(alignment:.leading,spacing:4){kind;rating}
        }.font(.caption2.weight(.medium)).foregroundStyle(.secondary)
            .frame(maxWidth:.infinity,minHeight:16,alignment:.leading)
    }
    private var kind:some View {Text(homeKind(item.kind)).fixedSize(horizontal:true,vertical:true)}
    @ViewBuilder private var rating:some View {if let rating=item.rating,rating>0{RatingValue(rating:rating).foregroundStyle(FlyxTheme.accent)}}
}

private struct HomeArtwork:View {
    let item:RemoteTitle
    var backdrop=false
    var body:some View {GeometryReader{geometry in
        AsyncImage(url:(backdrop ? item.backdropURL ?? item.posterURL:item.posterURL).flatMap(URL.init(string:))){phase in
            if let image=phase.image{image.resizable().scaledToFill().frame(width:geometry.size.width,height:geometry.size.height).clipped()}
            else if phase.error != nil || item.posterURL==nil{ZStack{FlyxTheme.card;Image(systemName:item.kind=="manga" ? "book.closed":"film").font(.largeTitle).foregroundStyle(.secondary)}.frame(width:geometry.size.width,height:geometry.size.height)}
            else{Rectangle().fill(.white.opacity(0.06)).loadingShimmer()}
        }.transaction{$0.animation=nil}
    }
    #if DEBUG
    .overlay{if ProcessInfo.processInfo.arguments.contains("home-edge48"){FlyxTheme.accent}}
    #endif
    .accessibilityHidden(true)}
}

private struct HomeRailHeader:View {
    let title:String;let subtitle:String;var placeholder=false
    var body:some View {VStack(alignment:.leading,spacing:4){Text(title).font(.title3.bold()).lineLimit(1);Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)}.redacted(reason:placeholder ? .placeholder:[]).padding(.horizontal,HomeLayout.inset)}
}
private struct HomePosterSkeletonCard:View {
    var body:some View {PosterCardSlots(posterHeight:HomeLayout.posterHeight,metadataHeight:16,titleHeight:42,cornerRadius:14,expandsMetadata:true){Rectangle().fill(.white.opacity(0.06))}metadata:{HomeTitleMetadata(item:.init(id:"placeholder",kind:"movie",title:"",overview:"",posterURL:nil,rating:8.5,releaseDate:"2026")).redacted(reason:.placeholder)}title:{Text("Loading title\nSecond title line").font(.subheadline.weight(.semibold)).redacted(reason:.placeholder)}.frame(width:HomeLayout.posterWidth).accessibilityHidden(true)}
}
private struct HomeFeedSkeleton:View {
    var body:some View {VStack(alignment:.leading,spacing:HomeLayout.sectionSpacing){
        ZStack(alignment:.bottomLeading){RoundedRectangle(cornerRadius:24,style:.continuous).fill(.white.opacity(0.06));VStack(alignment:.leading,spacing:10){Text("Featured category").font(.caption.bold());Text("Loading featured title").font(.title.bold());Text("Loading title metadata").font(.caption2);Text("Loading overview\nSecond overview line").font(.subheadline);Capsule().fill(.quaternary).frame(width:148,height:46)}.redacted(reason:.placeholder).padding(20)}.frame(height:HomeLayout.featuredHeight).padding(.horizontal,HomeLayout.inset)
        ForEach(0..<2,id:\.self){_ in VStack(alignment:.leading,spacing:HomeLayout.railSpacing){
            HomeRailHeader(title:"Loading section",subtitle:"Loading titles",placeholder:true)
            ScrollView(.horizontal){HStack(alignment:.top,spacing:HomeLayout.railSpacing){ForEach(0..<3,id:\.self){_ in HomePosterSkeletonCard()}}}.contentMargins(.horizontal,HomeLayout.inset,for:.scrollContent).scrollDisabled(true).scrollIndicators(.hidden)
        }}
    }.loadingShimmer().allowsHitTesting(false).accessibilityElement(children:.ignore).accessibilityLabel("Loading Home")}
}

private func homeKind(_ kind:String)->String {
    switch kind{case "movie":return "Movie";case "tv":return "TV";case "anime":return "Anime";case "manga":return "Manga";default:return "Title"}
}

#if DEBUG
/// One offline layout check for the clipped Home score and Browse badge.
struct RatingClippingFixture:View {
    private let item=RemoteTitle(id:"rating-fixture",kind:"movie",title:"Rating layout",overview:"",posterURL:nil,rating:8.65,releaseDate:"2026-10-18")
    var body:some View {NavigationStack{ScrollView{VStack(alignment:.leading,spacing:HomeLayout.sectionSpacing){
        Text("SYNTHETIC · NO NETWORK").font(.caption).foregroundStyle(.secondary)
        HStack(alignment:.top,spacing:18){sample(width:148,label:"Home · 148 pt");sample(width:128,label:"Home · 128 pt")}
        Text("Larger text").font(.headline)
        HStack(alignment:.top,spacing:18){sample(width:148,label:"148 pt");sample(width:128,label:"128 pt")}.dynamicTypeSize(.xxxLarge)
        Text("Browse poster badges").font(.headline)
        HStack(spacing:18){badge(width:148,rating:8.65);badge(width:128,rating:10)}
    }.padding(20)}.background(.black).navigationTitle("Rating layout").navigationBarTitleDisplayMode(.inline)}}
    private func sample(width:CGFloat,label:String)->some View {VStack(alignment:.leading,spacing:12){Text(label).font(.caption);RoundedRectangle(cornerRadius:14).fill(FlyxTheme.card).frame(height:90);HomeTitleMetadata(item:item);Text("Full score visible").font(.caption).foregroundStyle(.secondary)}.frame(width:width)}
    private func badge(width:CGFloat,rating:Double)->some View {RoundedRectangle(cornerRadius:14).fill(FlyxTheme.card).frame(width:width,height:110).clipShape(.rect(cornerRadius:14)).overlay(alignment:.bottomLeading){PosterRating(rating:rating).padding(8)}}
}
#endif
