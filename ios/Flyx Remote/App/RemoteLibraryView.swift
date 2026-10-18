import SwiftUI
struct RemoteLibraryView: View {
    let client: RemoteClient
    var watchlist:RemoteWatchlist? = nil
    @State private var browser = CatalogBrowser()
    @State private var filtersPresented = false
    @State private var voteQualification=false
    @State private var path: [RemoteTitle] = []
    @FocusState private var searchFocused: Bool
    private let categories = [("movie","Movies"),("tv","TV"),("anime","Anime"),("manga","Manga")]
    var body: some View {
        NavigationStack(path:$path) {ScrollViewReader{scroll in VStack(spacing:0){catalogueHeader.zIndex(100)
                ScrollView {
                    LazyVGrid(columns:CatalogLayout.columns,spacing:CatalogLayout.rowSpacing) {
                        if browser.showsSkeleton {
                            ForEach(0..<8,id:\.self) { _ in CatalogSkeletonCard() }
                        } else {
                            let cardRequest=browser.request
                            ForEach(browser.snapshot.items,id:\.stableID) { item in
                                ZStack(alignment:.topLeading){Button {guard browser.canNavigate(item,from:cardRequest) else{return};path.append(item)} label:{CatalogCard(item:item).contentShape(Rectangle())}.buttonStyle(.plain);if let watchlist{WatchlistSaveButton(item:item,model:watchlist,client:client).padding(8)}}.id(item.stableID).task(id:"\(item.stableID):\(browser.snapshot.nextPage ?? 0)"){guard path.isEmpty else{return};await browser.loadAutomatically(near:item.stableID){selection,page in try await client.catalog(selection,page:page)}}
                            }
                        }
                    }.loadingShimmer(browser.showsSkeleton).padding(.top,12).scrollTargetLayout()
                    if browser.isEmpty { ContentUnavailableView("No titles found",systemImage:"magnifyingglass",description:Text("Try a different search or reset the filters.")) }
                    if browser.snapshot.nextPage != nil || browser.loadingMore {Group{if browser.loadingMore{ProgressView("Loading more…")}else{Color.clear} }.frame(maxWidth:.infinity,minHeight:48).accessibilityIdentifier("catalog.loading-more")}
                    if browser.snapshot.loaded && browser.snapshot.items.isEmpty && browser.snapshot.nextPage != nil && browser.error==nil {
                        ProgressView("Searching more provider results…").task(id:browser.snapshot.nextPage){await browser.loadAutomatically(near:nil){selection,page in try await client.catalog(selection,page:page)}}
                    }
                }.scrollPosition(id:Binding(get:{browser.anchor},set:{browser.anchor=$0}))
                    .scrollDismissesKeyboard(.interactively)
                    .padding(.horizontal,CatalogLayout.inset)
                    }
                    .background(.black)
                    .toolbar(path.isEmpty ? .hidden:.visible,for:.navigationBar)
                .navigationDestination(for:RemoteTitle.self){RemoteDetailView(client:client,item:$0,watchlist:watchlist)}
                .sheet(isPresented:$filtersPresented){CatalogFilterSheet(request:browser.request,supportsVoteQualification:voteQualification){browser.apply($0)}}
                .task{struct Features:Decodable{var features:[String]?};if let value:Features=try? await client.request("/remote/v1/info"){voteQualification=value.features?.contains("catalog.minVotes")==true}}
                .task(id:browser.request){await load()}
                #if DEBUG
                .onChange(of:path){_,value in UIOnlyProtocol.probe(["navigationKinds":value.map(\.kind),"navigationCount":value.count])}
                .onChange(of:browser.request.kind){_,value in UIOnlyProtocol.probe(["catalogueSelectedKind":value])}
                #endif
                .transaction{$0.animation=nil}
                #if DEBUG
                .onChange(of:browser.snapshot.items.count){_,_ in
                    if (ProcessInfo.processInfo.arguments.contains("pagination") || ProcessInfo.processInfo.arguments.contains("touch-delayed")){Task{try? await Task.sleep(for:.milliseconds(300));if let last=browser.snapshot.items.last{scroll.scrollTo(last.stableID,anchor:.bottom)}}}
                }
                #endif
        }}
    }
    private var catalogueHeader:some View {VStack(spacing:8){
                    HStack(alignment:.firstTextBaseline,spacing:10){Text("Flyx").font(.title2.bold()).foregroundStyle(FlyxTheme.accent);Text("Browse").font(.title2.bold());Spacer();MacConnectionIndicator(client:client)}.frame(minHeight:36)
                GlassCategorySelector(selected:browser.request.kind){searchFocused=false;path.removeAll();browser.select($0)}
                HStack {
                    Image(systemName:"magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search \(categories.first{$0.0 == browser.request.kind}?.1.lowercased() ?? "catalogue")",text:Binding(get:{browser.request.query},set:{browser.search($0)}))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().focused($searchFocused).submitLabel(.search).onSubmit{searchFocused=false}.accessibilityIdentifier("catalog.search")
                    if !browser.request.query.isEmpty { Button {browser.search("")} label:{Image(systemName:"xmark.circle.fill")}.accessibilityLabel("Clear search") }
                    Button { searchFocused=false;filtersPresented=true } label:{Image(systemName:browser.request.filters.activeCount>0 ? "line.3.horizontal.decrease.circle.fill":"line.3.horizontal.decrease.circle").font(.title2).frame(width:44,height:44)}
                        .accessibilityLabel("Filters").accessibilityIdentifier("catalog.filters")
                }.padding(.leading,14).background(FlyxTheme.card.opacity(0.85),in:.rect(cornerRadius:14))
                if let error=browser.error {HStack{Text(error).lineLimit(2);Spacer();Button("Retry"){Task{await load(more:browser.snapshot.loaded)}}}.font(.caption).foregroundStyle(.orange).padding(.vertical,4)}
                else if browser.request != CatalogRequest(kind:browser.request.kind){HStack{Text(browser.request.filters.activeCount>0 ? "\(browser.request.filters.activeCount) active filters":"Search results");Spacer();Button("Reset"){browser.reset()}}.font(.caption).foregroundStyle(.secondary).frame(minHeight:28)}
                    }.padding(.horizontal,CatalogLayout.inset).padding(.top,2).padding(.bottom,10).background{ZStack{Color.black.contentShape(Rectangle()).onTapGesture{searchFocused=false};CatalogueGlassHeader()}}.contentShape(Rectangle()).zIndex(100)}
    private func load(more:Bool=false) async {
        await browser.load(more:more){selection,page in try await client.catalog(selection,page:page)}
        if browser.snapshot.loaded {await ConnectionVerification.shared.loadedCatalog(itemCount:browser.snapshot.items.count)}
    }
}
enum CatalogLayout {
    static let inset:CGFloat=16
    static let columnSpacing:CGFloat=16
    static let rowSpacing:CGFloat=20
    static var columns:[GridItem]{[GridItem(.adaptive(minimum:132,maximum:220),spacing:columnSpacing)]}
}

/// The same poster, metadata and title slots back real cards and placeholders.
struct PosterCardSlots<Poster:View,Metadata:View,Title:View>:View {
    let poster:Poster;let metadata:Metadata;let title:Title
    let fixedPosterHeight:CGFloat?;let cornerRadius:CGFloat;let expandsMetadata:Bool
    @ScaledMetric private var metadataHeight:CGFloat
    @ScaledMetric private var titleHeight:CGFloat
    @Environment(\.dynamicTypeSize) private var dynamicType
    init(posterHeight:CGFloat?=nil,metadataHeight:CGFloat=18,titleHeight:CGFloat=44,cornerRadius:CGFloat=12,expandsMetadata:Bool=false,@ViewBuilder poster:()->Poster,@ViewBuilder metadata:()->Metadata,@ViewBuilder title:()->Title){
        self.poster=poster();self.metadata=metadata();self.title=title();fixedPosterHeight=posterHeight;self.cornerRadius=cornerRadius;self.expandsMetadata=expandsMetadata
        _metadataHeight=ScaledMetric(wrappedValue:metadataHeight,relativeTo:.caption);_titleHeight=ScaledMetric(wrappedValue:titleHeight,relativeTo:.subheadline)
    }
    var body:some View {VStack(alignment:.leading,spacing:8){
        posterSlot.clipShape(.rect(cornerRadius:cornerRadius))
        metadata.frame(height:metadataHeight*(expandsMetadata && dynamicType.isAccessibilitySize ? 2:1),alignment:.leading)
        title.frame(height:titleHeight,alignment:.topLeading).frame(maxWidth:.infinity,alignment:.leading)
    }}
    @ViewBuilder private var posterSlot:some View {
        if let fixedPosterHeight{Color.clear.frame(height:fixedPosterHeight).overlay{poster}}
        else{Color.clear.aspectRatio(2/3,contentMode:.fit).overlay{poster}}
    }
}
struct CatalogCard:View {
    let item:RemoteTitle
    var body:some View {PosterCardSlots{
        RemotePoster(item:item).overlay(alignment:.bottomLeading){PosterRating(rating:item.rating).padding(8)}
    }metadata:{
        HStack(spacing:4){Text(metadataDate);Spacer(minLength:0);if let votes=item.voteCount{Text("\(votes.formatted(.number.notation(.compactName))) ratings").accessibilityLabel("\(votes) rating votes")}}.font(.caption).foregroundStyle(.secondary).lineLimit(1)
    }title:{Text(item.title).font(.subheadline.bold()).lineLimit(2)}}
    private var metadataDate:String {
        guard let raw=item.releaseDate else{return " "}
        if raw.count>=10,let date=try? Date(String(raw.prefix(10)),strategy:.iso8601.year().month().day().dateSeparator(.dash)){return date.formatted(.dateTime.day().month(.abbreviated).year())}
        return String(raw.prefix(4))
    }
}
struct CatalogSkeletonCard:View {
    var body:some View {PosterCardSlots{Rectangle().fill(.quaternary)}metadata:{
        Text("Loading date").font(.caption).redacted(reason:.placeholder)
    }title:{Text("Loading title\nSecond title line").font(.subheadline.bold()).redacted(reason:.placeholder)}
        .accessibilityElement(children:.ignore).accessibilityLabel("Loading title").allowsHitTesting(false)}
}

struct CatalogFilterSheet:View {
    let request:CatalogRequest
    let apply:(CatalogFilters)->Void
    var supportsVoteQualification:Bool
    @Environment(\.dismiss) private var dismiss
    @State private var draft:CatalogFilters
    init(request:CatalogRequest,supportsVoteQualification:Bool=false,apply:@escaping(CatalogFilters)->Void){self.request=request;self.supportsVoteQualification=supportsVoteQualification;self.apply=apply;_draft=State(initialValue:request.filters)}
    private var genres:[(String,String)] {
        switch request.kind {
        case "movie":return [("28","Action"),("12","Adventure"),("16","Animation"),("35","Comedy"),("80","Crime"),("99","Documentary"),("18","Drama"),("14","Fantasy"),("27","Horror"),("9648","Mystery"),("10749","Romance"),("878","Science fiction"),("53","Thriller")]
        case "tv":return [("10759","Action & adventure"),("16","Animation"),("35","Comedy"),("80","Crime"),("99","Documentary"),("18","Drama"),("10751","Family"),("10762","Kids"),("9648","Mystery"),("10764","Reality"),("10765","Sci-fi & fantasy")]
        default:return [("1","Action"),("2","Adventure"),("4","Comedy"),("8","Drama"),("10","Fantasy"),("14","Horror"),("7","Mystery"),("22","Romance"),("24","Science fiction"),("36","Slice of life"),("30","Sports"),("37","Supernatural"),("41","Thriller")]
        }
    }
    var body:some View {NavigationStack {Form {
        if request.kind != "manga" {
            Section("Match titles") {
                Picker("Genre",selection:$draft.genre){Text("Any genre").tag("");ForEach(genres,id:\.0){Text($0.1).tag($0.0)}}
                TextField("From year (any)",text:$draft.yearFrom).keyboardType(.numberPad)
                TextField("Through year (any)",text:$draft.yearTo).keyboardType(.numberPad)
                Picker("Minimum rating",selection:$draft.minRating){Text("Any rating").tag(0);ForEach(1..<10){Text("\($0)+ / 10").tag($0)}}
                if !draft.isValid {Text("Use years from 1900 through this year, with From no later than Through.").foregroundStyle(.orange)}
            }
        } else {Section {Text("This manga provider supports title search and popular/latest feeds. Genre, year, rating and pagination are unavailable.").font(.footnote).foregroundStyle(.secondary)}}
        Section("Order") {
            if !request.query.isEmpty && request.kind != "anime" {Text("Text searches use provider relevance. Movie/TV filters continue across provider pages.").font(.footnote).foregroundStyle(.secondary)}
            else {Picker("Sort",selection:$draft.sort){Text("Popularity").tag("popularity");if request.kind != "manga"{Text("Top rated").tag("rating").disabled(!supportsVoteQualification)};Text(request.kind == "manga" ? "Latest updates":"Newest").tag("release_date")}}
        }
        if request.kind != "manga" {
            if draft.sort=="rating",supportsVoteQualification {Section("Rating confidence"){TextField("Minimum number of rating votes",value:$draft.minVotes,format:.number).keyboardType(.numberPad).accessibilityIdentifier("filters.min-votes");Text("Only titles with at least \(draft.minVotes) rating votes qualify. Default: 10.").font(.footnote).foregroundStyle(.secondary);if request.kind=="anime"{Text("Anime uses actual scored-by votes. The Mac checks each provider page; member/popularity counts are not votes.").font(.footnote).foregroundStyle(.secondary)}}}
            if !supportsVoteQualification{Text("Top rated with a minimum vote count requires the updated Mac catalogue bridge.").font(.footnote).foregroundStyle(.secondary)}
        }
        Section {Button("Clear filters"){draft=CatalogFilters()}}
    }.navigationTitle("Filters").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement:.cancellationAction){Button("Cancel"){dismiss()}}
        ToolbarItem(placement:.confirmationAction){Button("Apply"){apply(draft);dismiss()}.disabled(!draft.isValid || (draft.sort=="rating" && !supportsVoteQualification)).accessibilityIdentifier("filters.apply")}
    }}}
}

struct RemotePoster:View {
    let item:RemoteTitle
    private var symbol:String {switch item.kind {case "manga":"book.closed";case "tv":"tv";case "anime":"play.rectangle";default:"film"}}
    var body:some View {GeometryReader {geometry in
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("header")||$0=="pagination"||$0.hasSuffix("41")}) {
            ZStack{LinearGradient(colors:[.orange,.red,.indigo],startPoint:.topLeading,endPoint:.bottomTrailing);Image(systemName:symbol).font(.system(size:70,weight:.ultraLight)).foregroundStyle(.white.opacity(0.35))}.frame(width:geometry.size.width,height:geometry.size.height)
        }else{imageContent(geometry)}
        #else
        imageContent(geometry)
        #endif
    }.accessibilityHidden(true)}
    private func imageContent(_ geometry:GeometryProxy)->some View {
        AsyncImage(url:item.posterURL.flatMap(URL.init(string:))) {phase in
            if let image=phase.image {image.resizable().scaledToFill().frame(width:geometry.size.width,height:geometry.size.height).clipped()}
            else if phase.error != nil || item.posterURL == nil {ZStack{Color.secondary.opacity(0.12);Image(systemName:symbol).font(.largeTitle).foregroundStyle(.secondary)}.frame(width:geometry.size.width,height:geometry.size.height)}
            else {RoundedRectangle(cornerRadius:12).fill(.quaternary).frame(width:geometry.size.width,height:geometry.size.height)}
        }.transaction{$0.animation=nil}
    }
}

#if DEBUG
struct SkeletonGeometryFixture:View {
    let mode:String
    private var kinds:[String]{mode.contains("landscape") ? ["tv","manga"]:["movie","anime"]}
    var body:some View {ScrollView{VStack(alignment:.leading,spacing:16){
        Text("SKELETON / LOADED · SHARED GEOMETRY").font(.caption)
        LazyVGrid(columns:CatalogLayout.columns,spacing:CatalogLayout.rowSpacing){ForEach(kinds,id:\.self){kind in
            CatalogSkeletonCard().loadingShimmer().onGeometryChange(for:CGSize.self,of:{$0.size}){size in UIOnlyProtocol.probe(["skeleton-"+kind:[size.width,size.height]])}
            CatalogCard(item:.init(id:kind,kind:kind,title:kind.capitalized+" sample\nSecond title line",overview:"",posterURL:nil,rating:8.5,releaseDate:"2026-10-18",voteCount:1200)).onGeometryChange(for:CGSize.self,of:{$0.size}){size in UIOnlyProtocol.probe(["loaded-"+kind:[size.width,size.height]])}
        }}
    }.padding(CatalogLayout.inset).frame(maxWidth:mode.contains("small") ? 320:.infinity).frame(maxWidth:.infinity)}.background(.black)
        .task{if mode.contains("landscape"){for case let scene as UIWindowScene in UIApplication.shared.connectedScenes{scene.requestGeometryUpdate(.iOS(interfaceOrientations:.landscapeLeft))}}}}
}
#endif
