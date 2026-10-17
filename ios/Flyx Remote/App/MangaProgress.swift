import Foundation

struct MangaEditionKey:Codable,Hashable,Sendable {
    let provider:String
    let mangaID:String
    let language:String
    let edition:String
}
struct MangaReadingMark:Codable,Equatable,Sendable {
    let identity:MangaEditionKey
    let chapterID:String
    let chapterNumber:Double
    let page:Int
    let mode:String
    let direction:String
    let updatedAt:Date
    var valid:Bool {
        !identity.provider.isEmpty && !identity.mangaID.isEmpty && !identity.language.isEmpty && !identity.edition.isEmpty && !chapterID.isEmpty && chapterNumber.isFinite && chapterNumber>=0 && (1...10000).contains(page) && ["vertical","paged"].contains(mode) && ["ltr","rtl"].contains(direction)
    }
}
enum MangaProgressError:Error {case invalidMark}
/// Phone-local, edition-exact progress. Never overwrites legacy Mac progress
/// whose schema lacks edition/language identity.
@MainActor final class MangaProgressStore {
    private let file:URL
    init(file:URL?=nil) {
        self.file=file ?? FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("manga-reader-progress.json")
    }
    private func records()->[MangaReadingMark] {
        guard let data=try? Data(contentsOf:file),data.count<1_048_576,let values=try? JSONDecoder().decode([MangaReadingMark].self,from:data) else{return []}
        return values.filter(\.valid)
    }
    func latest(provider:String,mangaID:String)->[MangaReadingMark]{records().filter{$0.identity.provider==provider && $0.identity.mangaID==mangaID}}
    func load(_ identity:MangaEditionKey)->MangaReadingMark? {records().first{$0.identity==identity}}
    func save(_ mark:MangaReadingMark)throws {
        guard mark.valid else{throw MangaProgressError.invalidMark}
        let next=Array(([mark]+records().filter{$0.identity != mark.identity}).prefix(200))
        try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
        let data=try JSONEncoder().encode(next)
        #if os(iOS)
        try data.write(to:file,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to:file,options:.atomic)
        #endif
    }
}
