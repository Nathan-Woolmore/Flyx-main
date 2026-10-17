#if DEBUG
import SwiftUI
struct BaselineCatalogueFixture: View {
    let client: RemoteClient
    var watchlist:RemoteWatchlist? = nil
    @State private var browser = CatalogBrowser()
    @State private var filtersPresented = false
    @State private var path: [RemoteTitle] = []
    @FocusState private var searchFocused: Bool
    private let categories = [("movie","Movies"),("tv","TV"),("anime","Anime"),("manga","Manga")]
    var body: some View {
        NavigationStack(path:$path) {ScrollViewReader{scroll in
                ScrollView {
                    LazyVGrid(columns:[GridItem(.flexible(),spacing:16),GridItem(.flexible(),spacing:16)],spacing:20) {
                        if browser.showsSkeleton {
                            ForEach(0..<8,id:\.self) { _ in CatalogSkeletonCard() }
                        } else {
                            ForEach(browser.snapshot.items,id:\.stableID) { item in
                                ZStack(alignment:.topLeading){NavigationLink(value:item) { CatalogCard(item:item) }.buttonStyle(.plain);if let watchlist{WatchlistSaveButton(item:item,model:watchlist,client:client).padding(8)}}.id(item.stableID).task{guard path.isEmpty else{return};await browser.loadAutomatically(near:item.stableID){selection,page in try await client.catalog(selection,page:page)}}
                            }
                        }
                    }.padding(.top,12).scrollTargetLayout()
                    if browser.isEmpty { ContentUnavailableView("No titles found",systemImage:"magnifyingglass",description:Text("Try a different search or reset the filters.")) }
                    if browser.loadingMore {ProgressView("Loading more…").frame(maxWidth:.infinity,minHeight:48).accessibilityIdentifier("catalog.loading-more")}
                    if browser.snapshot.loaded && browser.snapshot.items.isEmpty && browser.snapshot.nextPage != nil && browser.error==nil {
                        ProgressView("Searching more provider results…").task(id:browser.snapshot.nextPage){await browser.loadAutomatically(near:nil){selection,page in try await client.catalog(selection,page:page)}}
                    }
                }.scrollPosition(id:Binding(get:{browser.anchor},set:{browser.anchor=$0}))
                    .scrollDismissesKeyboard(.interactively).scrollClipDisabled()
                    .padding(.horizontal,16)
                    .safeAreaInset(edge:.top,spacing:0){VStack(spacing:8){
                    HStack(alignment:.firstTextBaseline){Text("Flyx").font(.title2.bold());Spacer();MacConnectionIndicator(client:client)}.frame(minHeight:36)
                LegacyCategorySelector(selected:browser.request.kind){searchFocused=false;browser.select($0)}
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
                    }.padding(.horizontal,16).padding(.top,2).padding(.bottom,10).background{CatalogueGlassHeader()}}
                    .background(FlyxTheme.background)
                    .toolbar(path.isEmpty ? .hidden:.visible,for:.navigationBar)
                .navigationDestination(for:RemoteTitle.self){RemoteDetailView(client:client,item:$0,watchlist:watchlist)}
                .sheet(isPresented:$filtersPresented){CatalogFilterSheet(request:browser.request){browser.apply($0)}}
                .task(id:browser.request){await load()}
                .transaction{$0.animation=nil}
                .onChange(of:path){_,value in UIOnlyProtocol.probe(["navigationKinds":value.map(\.kind),"navigationCount":value.count])}
                .onChange(of:browser.request.kind){_,value in UIOnlyProtocol.probe(["catalogueSelectedKind":value])}
                #if DEBUG
                .onChange(of:browser.snapshot.items.count){_,_ in
                    if ProcessInfo.processInfo.arguments.contains("touch-baseline"){Task{try? await Task.sleep(for:.milliseconds(300));if let last=browser.snapshot.items.last{scroll.scrollTo(last.stableID,anchor:.bottom)}}}
                }
                #endif
        }}
    }
    private func load(more:Bool=false) async {
        await browser.load(more:more){selection,page in try await client.catalog(selection,page:page)}
        if browser.snapshot.loaded {await ConnectionVerification.shared.loadedCatalog(itemCount:browser.snapshot.items.count)}
    }
}

import SwiftUI

struct LegacyCategorySelector:View {
    let selected:String
    let select:(String)->Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let options=[("movie","Movies"),("tv","TV"),("anime","Anime"),("manga","Manga")]
    private var opaque:Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("header-reduced"){return true}
        #endif
        return reduceTransparency
    }
    var body:some View {
        if #available(iOS 26,*),!opaque{GlassEffectContainer(spacing:4){row}}else{row}
    }
    private var row:some View {
        HStack(spacing:4){ForEach(options,id:\.0){kind,title in
            Button{select(kind)}label:{Text(title).font(.subheadline.weight(.semibold))
                .frame(maxWidth:.infinity,minHeight:44)
                .foregroundStyle(selected==kind ? FlyxTheme.ink:Color.primary)}
                .buttonStyle(.plain).modifier(LegacyCategoryGlass(selected:selected==kind,opaque:opaque))
                #if DEBUG
                .modifier(CategoryFrameVerification(kind:kind))
                #endif
                .accessibilityIdentifier("category."+kind).accessibilityAddTraits(selected==kind ? .isSelected:[])
        }}
    }
}
private struct LegacyCategoryGlass:ViewModifier {
    let selected:Bool
    let opaque:Bool
    @ViewBuilder func body(content:Content)->some View {
        if #available(iOS 26,*),!opaque{
            content.glassEffect(selected ? .regular.tint(FlyxTheme.accent.opacity(0.9)).interactive():.clear.interactive(),in:.capsule)
        }else{content.background(selected ? FlyxTheme.accent:FlyxTheme.card,in:.capsule)}
    }
}


#endif
