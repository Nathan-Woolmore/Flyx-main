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
                    LazyVGrid(columns:[GridItem(.flexible(),spacing:16),GridItem(.flexible(),spacing:16)],spacing:20) {
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
                    if browser.loadingMore {ProgressView("Loading more…").frame(maxWidth:.infinity,minHeight:48).accessibilityIdentifier("catalog.loading-more")}
                    if browser.snapshot.loaded && browser.snapshot.items.isEmpty && browser.snapshot.nextPage != nil && browser.error==nil {
                        ProgressView("Searching more provider results…").task(id:browser.snapshot.nextPage){await browser.loadAutomatically(near:nil){selection,page in try await client.catalog(selection,page:page)}}
                    }
                }.scrollPosition(id:Binding(get:{browser.anchor},set:{browser.anchor=$0}))
                    .scrollDismissesKeyboard(.interactively)
                    .padding(.horizontal,16)
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
                    HStack(alignment:.firstTextBaseline){Text("Flyx").font(.title2.bold());Spacer();MacConnectionIndicator(client:client)}.frame(minHeight:36)
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
                    }.padding(.horizontal,16).padding(.top,2).padding(.bottom,10).background{ZStack{Color.black.contentShape(Rectangle()).onTapGesture{searchFocused=false};CatalogueGlassHeader()}}.contentShape(Rectangle()).zIndex(100)}
    private func load(more:Bool=false) async {
        await browser.load(more:more){selection,page in try await client.catalog(selection,page:page)}
        if browser.snapshot.loaded {await ConnectionVerification.shared.loadedCatalog(itemCount:browser.snapshot.items.count)}
    }
}
struct CatalogCard:View {
    let item:RemoteTitle
    var body:some View { VStack(alignment:.leading,spacing:8) {
        RemotePoster(item:item).frame(height:220).clipShape(.rect(cornerRadius:12)).overlay(alignment:.bottomLeading){PosterRating(rating:item.rating).padding(8)}
        HStack(spacing:4){Text(metadataDate);Spacer(minLength:0);if let votes=item.voteCount{Text("\(votes.formatted(.number.notation(.compactName))) ratings").accessibilityLabel("\(votes) rating votes")}}.font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(minHeight:18,alignment:.leading)
        Text(item.title).font(.subheadline.bold()).lineLimit(2).frame(height:44,alignment:.topLeading).frame(maxWidth:.infinity,alignment:.leading)
    } }
    private var metadataDate:String {
        guard let raw=item.releaseDate else{return " "}
        if raw.count>=10,let date=try? Date(String(raw.prefix(10)),strategy:.iso8601.year().month().day().dateSeparator(.dash)) {return date.formatted(.dateTime.day().month(.abbreviated).year())}
        return String(raw.prefix(4))
    }
}
struct CatalogSkeletonCard:View {
    var body:some View {VStack(alignment:.leading,spacing:8){
        RoundedRectangle(cornerRadius:12).fill(.quaternary).frame(height:220)
        RoundedRectangle(cornerRadius:3).fill(.quaternary).frame(width:100,height:12).frame(height:18)
        VStack(alignment:.leading,spacing:7){RoundedRectangle(cornerRadius:3).fill(.quaternary).frame(height:12);RoundedRectangle(cornerRadius:3).fill(.quaternary).frame(width:90,height:12)}.frame(height:44,alignment:.top)
    }.accessibilityLabel("Loading title").allowsHitTesting(false)}
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
