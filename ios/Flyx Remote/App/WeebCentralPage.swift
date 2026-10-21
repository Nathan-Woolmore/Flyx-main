import Foundation

struct WeebSeries: Sendable {
    let providerID: String, slug: String, title: String
    let posterURL: String?
}
enum WeebCentralPage {
    static func matches(_ pattern:String,_ text:String)throws -> [[String]] {
        let regex=try NSRegularExpression(pattern:pattern,options:[.caseInsensitive,.dotMatchesLineSeparators])
        return regex.matches(in:text,range:NSRange(text.startIndex...,in:text)).map{match in (0..<match.numberOfRanges).map{Range(match.range(at:$0),in:text).map{String(text[$0])} ?? ""}}
    }
    static func text(_ html:String)->String {
        html.replacingOccurrences(of:"<[^>]+>",with:" ",options:.regularExpression)
            .replacingOccurrences(of:"&amp;",with:"&").replacingOccurrences(of:"&quot;",with:"\"")
            .replacingOccurrences(of:"&#39;",with:"'").replacingOccurrences(of:"&nbsp;",with:" ")
            .replacingOccurrences(of:"\\s+",with:" ",options:.regularExpression).trimmingCharacters(in:.whitespacesAndNewlines)
    }
    static func series(_ html:String)throws->[WeebSeries] {
        let regex=try NSRegularExpression(pattern:#"href=["']https://weebcentral\.com/series/([0-9A-HJKMNP-TV-Z]{26})/([A-Za-z0-9._-]{1,300})["']"#,options:.caseInsensitive)
        var seen=Set<String>(),items:[WeebSeries]=[]
        for match in regex.matches(in:html,range:NSRange(html.startIndex...,in:html)) {
            guard let idRange=Range(match.range(at:1),in:html),let slugRange=Range(match.range(at:2),in:html),let full=Range(match.range,in:html) else{continue}
            let id=String(html[idRange]),slug=String(html[slugRange]);guard seen.insert(id).inserted else{continue}
            let end=html.index(full.upperBound,offsetBy:2600,limitedBy:html.endIndex) ?? html.endIndex
            let block=String(html[full.lowerBound..<end])
            let cover=try matches(#"(?:src|srcset)=["'](https://temp\.compsci88\.com/cover/(?:normal|fallback)/"#+NSRegularExpression.escapedPattern(for:id)+#"\.(?:webp|jpg))["']"#,block).first?[1]
            let title=try matches(#"alt=["']([^"']+) cover["']"#,block).first?[1] ?? slug.replacingOccurrences(of:"-",with:" ")
            items.append(.init(providerID:id,slug:slug,title:text(title),posterURL:cover))
        }
        return items
    }
    static func chapters(_ html:String)throws->[RemoteDetails.Chapter] {
        let links=try matches(#"<a\b[^>]*href=["']/chapters/([0-9A-HJKMNP-TV-Z]{26})["'][^>]*>(.*?)</a>"#,html)
        guard !links.isEmpty || html.range(of:"no chapters",options:.caseInsensitive) != nil else{throw RemoteFailure(message:"The manga provider did not return a chapter list. Please retry.")}
        guard links.count<=5000 else{throw RemoteFailure(message:"This manga has too many chapters to open safely on this iPhone.")}
        var seen=Set<String>(),chapters:[RemoteDetails.Chapter]=[]
        for link in links where seen.insert(link[1]).inserted {
            let label=try matches(#"<span\b[^>]*class=["']["'][^>]*>(.*?)</span>"#,link[2]).first?[1] ?? text(link[2])
            guard let numberString=try matches(#"(?:Chapter\s*)?([0-9]+(?:\.[0-9]+)?)"#,text(label)).first?[1],let number=Double(numberString) else{throw RemoteFailure(message:"The provider returned an unnumbered chapter. Its order could not be confirmed.")}
            let official=link[2].contains("chapter-badge-official")
            chapters.append(.init(id:link[1],number:number,title:text(label),language:"en",edition:official ? "official":"community",editionLabel:official ? "Official":"Community"))
        }
        return chapters.sorted{if $0.number == $1.number{return $0.id<$1.id};return $0.number<$1.number}
    }
    static func pages(_ html:String)throws->[URL] {
        var pages:[URL]=[]
        for tag in try matches(#"<img\b[^>]*>"#,html) {
            guard let raw=try matches(#"\ssrc=["']([^"']+)["']"#,tag[0]).first?[1],let url=URL(string:raw.replacingOccurrences(of:"&amp;",with:"&")),
                  url.scheme=="https",url.user==nil,url.password==nil,url.port==nil || url.port==443,
                  let host=url.host,[".planeptune.us",".lastation.us",".lowee.us"].contains(where:{host.hasSuffix($0)}),
                  ["png","jpg","jpeg","webp"].contains(url.pathExtension.lowercased()) else{throw RemoteFailure(message:"The manga provider returned an unsupported page address.")}
            pages.append(url)
        }
        guard (1...1000).contains(pages.count) else{throw RemoteFailure(message:"The provider did not return readable pages for this chapter.")}
        return pages
    }
}
