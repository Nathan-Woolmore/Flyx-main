import Foundation
import Observation

struct CatalogFilters: Hashable, Sendable {
    var genre = ""
    var yearFrom = ""
    var yearTo = ""
    var minRating = 0
    var minVotes = 10
    var sort = "popularity"
    var isValid: Bool {
        let current = Calendar.current.component(.year, from: Date())
        let from = yearFrom.isEmpty ? 1900 : Int(yearFrom) ?? 0
        let to = yearTo.isEmpty ? current : Int(yearTo) ?? 0
        return from >= 1900 && to <= current && from <= to && (0...1_000_000).contains(minVotes)
    }
    var activeCount: Int { (genre.isEmpty ? 0:1)+(yearFrom.isEmpty && yearTo.isEmpty ? 0:1)+(minRating == 0 ? 0:1)+(sort == "popularity" ? 0:1) }
}
struct CatalogRequest: Hashable, Sendable {
    var kind = "movie"
    var query = ""
    var filters = CatalogFilters()
    var effectiveSort: String { !query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && kind != "anime" ? "relevance":filters.sort }
    func queryItems(page: Int) -> [URLQueryItem] {
        var values = [URLQueryItem(name:"kind",value:kind),.init(name:"q",value:query.trimmingCharacters(in:.whitespacesAndNewlines)),.init(name:"page",value:String(page)),.init(name:"sort",value:effectiveSort)]
        if kind != "manga" {
            if !filters.genre.isEmpty { values.append(.init(name:"genre",value:filters.genre)) }
            if !filters.yearFrom.isEmpty { values.append(.init(name:"yearFrom",value:filters.yearFrom)) }
            if !filters.yearTo.isEmpty { values.append(.init(name:"yearTo",value:filters.yearTo)) }
            if filters.sort == "rating" {values.append(.init(name:"minVotes",value:String(filters.minVotes)))}
            if filters.minRating > 0 { values.append(.init(name:"minRating",value:String(filters.minRating))) }
        }
        return values
    }
}
struct CatalogSnapshot {
    var items: [RemoteTitle] = []
    var nextPage: Int?
    var loaded = false
    var anchor: String?
    var fetchedPages:Set<Int>=[]
}

@MainActor @Observable final class CatalogBrowser {
    private(set) var request = CatalogRequest()
    private(set) var snapshot = CatalogSnapshot()
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var error: String?
    private var snapshots: [CatalogRequest:CatalogSnapshot] = [:]
    private var categories: [String:CatalogRequest] = [:]
    private var generation = UUID()
    private var source:URL?
    func useSource(_ endpoint:URL){
        guard source != endpoint else{return};source=endpoint;generation=UUID();loading=false;loadingMore=false;error=nil
        snapshots.removeAll();snapshot.loaded=false;snapshot.nextPage=nil;snapshot.fetchedPages.removeAll()
    }
    var anchor: String? { get { snapshot.anchor } set { snapshot.anchor = newValue } }
    var showsSkeleton: Bool { !snapshot.loaded && error == nil }
    var isEmpty: Bool { snapshot.loaded && snapshot.items.isEmpty && snapshot.nextPage == nil }
    private func activate(_ next: CatalogRequest) {
        guard request != next else { return }
        snapshots[request] = snapshot
        categories[request.kind] = request
        if snapshots.count > 16 { snapshots = snapshots.filter { $0.key == request || categories.values.contains($0.key) } }
        request = next; snapshot = snapshots[next] ?? CatalogSnapshot()
        generation = UUID(); loading = false; loadingMore = false; error = nil
    }
    func select(_ kind: String) { guard ["movie","tv","anime","manga"].contains(kind) else { return }; activate(categories[kind] ?? CatalogRequest(kind:kind)) }
    func canNavigate(_ item:RemoteTitle,from displayed:CatalogRequest)->Bool{displayed==request && item.kind==request.kind && snapshot.loaded && snapshot.items.contains(where:{$0.stableID==item.stableID})}
    func search(_ text: String) { var next=request;next.query=String(text.prefix(100));activate(next) }
    func apply(_ filters: CatalogFilters) { guard filters.isValid else { return };var next=request;next.filters=filters;activate(next) }
    func reset() { activate(CatalogRequest(kind:request.kind)) }
    func loadAutomatically(near id:String?,fetch:@Sendable(CatalogRequest,Int)async throws->CatalogPage)async {
        guard error==nil,snapshot.loaded,snapshot.nextPage != nil else{return}
        if let id{guard let index=snapshot.items.firstIndex(where:{$0.stableID==id}),index>=max(0,snapshot.items.count-6) else{return}}
        else{guard snapshot.items.isEmpty else{return}}
        await load(more:true,fetch:fetch)
    }
    func load(more: Bool = false, fetch: @Sendable (CatalogRequest,Int) async throws -> CatalogPage) async {
        guard !loading && !loadingMore, more ? snapshot.nextPage != nil:!snapshot.loaded else { return }
        let selected=request, ticket=generation, page=more ? snapshot.nextPage! : 1
        if more { loadingMore=true } else { loading=true }; error=nil
        defer { if generation == ticket { loading=false;loadingMore=false } }
        do {
            if !more && !selected.query.isEmpty { try await Task.sleep(for:.milliseconds(350)) }
            let result=try await fetch(selected,page)
            try Task.checkCancellation()
            guard ticket == generation && selected == request else { return }
            let existing=more ? snapshot.items:[]
            var seen=Set<String>()
            snapshot.items=(existing+result.items).filter { seen.insert($0.stableID).inserted }
            snapshot.fetchedPages.insert(page)
            if let next=result.nextPage,next<=page || snapshot.fetchedPages.contains(next){snapshot.nextPage=nil;error="The provider repeated its page cursor. Change filters to search again."}else{snapshot.nextPage=result.nextPage}
            snapshot.loaded=true
            snapshots[selected]=snapshot
        } catch is CancellationError { }
        catch { guard ticket == generation && !Task.isCancelled else { return };self.error=error.localizedDescription }
    }
}
