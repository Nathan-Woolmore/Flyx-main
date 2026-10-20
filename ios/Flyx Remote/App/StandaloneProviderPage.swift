import Foundation
import CryptoKit

/// Reads the advertised player iframe, never a server dropdown or a backup source.
enum StandaloneEmbedPlayer {
    enum Failure: Error, Equatable {
        case missing
        case invalidAddress
        case unsupportedHost(String)
    }

    static func resolve(html: String, pageURL: URL) throws -> URL {
        let frames = try NSRegularExpression(pattern: #"<iframe\b[^>]*>"#, options: [.caseInsensitive])
        let attribute = try NSRegularExpression(pattern: #"\s(id|data-src|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#, options: [.caseInsensitive])
        var candidates: [[String: String]] = []
        for frame in frames.matches(in: html, range: NSRange(html.startIndex..., in: html)) {
            guard let range = Range(frame.range, in: html) else { continue }
            let tag = String(html[range])
            var values: [String: String] = [:]
            for match in attribute.matches(in: tag, range: NSRange(tag.startIndex..., in: tag)) {
                guard let keyRange = Range(match.range(at: 1), in: tag),
                      let valueRange = (2...4).compactMap({ Range(match.range(at: $0), in: tag) }).first else { continue }
                values[String(tag[keyRange]).lowercased()] = String(tag[valueRange])
            }
            candidates.append(values)
        }
        // The provider's named player takes precedence over unrelated lazy-loaded frames.
        let selected = candidates.first { $0["id"]?.lowercased() == "iframesrc" }
            ?? candidates.first { $0["data-src"] != nil }
        guard let selected else { throw Failure.missing }
        let raw = selected["data-src"] ?? selected["src"] ?? ""
        let address = raw.replacingOccurrences(of: "&amp;", with: "&")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, let url = URL(string: address, relativeTo: pageURL)?.absoluteURL,
              url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased() else { throw Failure.invalidAddress }
        guard ["vidsrc.buzz", "videm.xyz"].contains(host) || (host == "streamsrcs.2embed.cc" && url.path == "/swish") else { throw Failure.unsupportedHost(host) }
        return url
    }
}

/// Decodes only the public player's string table. It never evaluates provider JavaScript.
enum StandaloneSwishPage {
    enum Failure: LocalizedError {
        case changed, unsupportedSource
        var errorDescription: String? {
            switch self {
            case .changed: "This provider's Swish player response has changed."
            case .unsupportedSource: "This provider did not return a supported clear HLS source."
            }
        }
    }

    static func playerURL(wrapper: URL) throws -> URL {
        guard wrapper.scheme == "https", wrapper.host == "streamsrcs.2embed.cc", wrapper.path == "/swish",
              wrapper.user == nil, wrapper.password == nil, wrapper.port == nil || wrapper.port == 443,
              let parts = URLComponents(url: wrapper, resolvingAgainstBaseURL: false),
              let id = parts.queryItems?.first(where: { $0.name == "id" })?.value,
              id.range(of: "^[A-Za-z0-9]{6,64}$", options: .regularExpression) != nil,
              let url = URL(string: "https://2vcdn.skin/e/" + id) else { throw Failure.changed }
        return url
    }

    static func source(html: String, player: URL) throws -> URL {
        guard html.utf8.count <= 2_097_152, player.scheme == "https", player.host == "2vcdn.skin" else { throw Failure.changed }
        let regex = try NSRegularExpression(pattern: #"\}\('((?:\\.|[^'\\])*)',36,([0-9]{1,4}),'((?:\\.|[^'\\])*)'\.split\('\|'\)"#)
        guard let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              let payloadRange = Range(match.range(at: 1), in: html),
              let countRange = Range(match.range(at: 2), in: html),
              let dictionaryRange = Range(match.range(at: 3), in: html),
              let count = Int(html[countRange]), (1...4096).contains(count) else { throw Failure.changed }
        let payload = try literal(String(html[payloadRange]))
        let words = try literal(String(html[dictionaryRange])).components(separatedBy: "|")
        guard words.count == count, payload.utf8.count <= 262_144 else { throw Failure.changed }
        let tokens = try NSRegularExpression(pattern: #"\b[0-9a-z]+\b"#)
        var plain = "", cursor = payload.startIndex
        for token in tokens.matches(in: payload, range: NSRange(payload.startIndex..., in: payload)) {
            guard let range = Range(token.range, in: payload) else { throw Failure.changed }
            plain.append(contentsOf: payload[cursor..<range.lowerBound])
            if let index = Int(payload[range], radix: 36), index < words.count, !words[index].isEmpty { plain.append(words[index]) }
            else { plain.append(contentsOf: payload[range]) }
            guard plain.utf8.count <= 1_048_576 else { throw Failure.changed }
            cursor = range.upperBound
        }
        plain.append(contentsOf: payload[cursor...])
        let links = try NSRegularExpression(pattern: #"\bvar\s+links\s*=\s*(\{[^\n]+?\});"#)
        guard let found = links.firstMatch(in: plain, range: NSRange(plain.startIndex..., in: plain)),
              let range = Range(found.range(at: 1), in: plain),
              let values = try JSONSerialization.jsonObject(with: Data(plain[range].utf8)) as? [String: String],
              let raw = ["hls4", "hls3", "hls2"].compactMap({ values[$0] }).first(where: { !$0.isEmpty }),
              let url = URL(string: raw, relativeTo: player)?.absoluteURL,
              url.scheme == "https", url.host == "2vcdn.skin", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, url.path.hasPrefix("/stream/"), url.pathExtension == "m3u8" else { throw Failure.unsupportedSource }
        // Pick the same first source as links.hls4 || links.hls3 || links.hls2.
        // A fetch failure never causes a request for another link.
        return url
    }

    /// The advertised media filename is independent evidence of the release being served.
    /// A successful HLS request alone says nothing about the movie's identity.
    static func verifyIdentity(html:String,expectedTitles:[String],expectedYear:Int?)throws{
        let tags=try NSRegularExpression(pattern:"<title[^>]*>([^<]{1,512})</title>",options:[.caseInsensitive])
        guard let match=tags.firstMatch(in:html,range:NSRange(html.startIndex...,in:html)),let range=Range(match.range(at:1),in:html) else{throw StandaloneMovieIdentityFailure.unidentified}
        let advertised=String(html[range]).replacingOccurrences(of:"&amp;",with:"&").replacingOccurrences(of:"&#39;",with:"'").replacingOccurrences(of:"&quot;",with:"\"")
        let years=try NSRegularExpression(pattern:#"(?:^|[\s._(\[-])((?:18|19|20)[0-9]{2})(?=[\s._)\]-]|$)"#)
        let matches=years.matches(in:advertised,range:NSRange(advertised.startIndex...,in:advertised))
        guard let last=matches.last,let yearRange=Range(last.range(at:1),in:advertised),let year=Int(advertised[yearRange]) else{throw StandaloneMovieIdentityFailure.unidentified}
        if let expectedYear,year != expectedYear{throw StandaloneMovieIdentityFailure.release(year,expectedYear)}
        func normalized(_ text:String)->String{text.folding(options:[.caseInsensitive,.diacriticInsensitive],locale:Locale(identifier:"en_US_POSIX")).filter{$0.isLetter || $0.isNumber}}
        let actual=normalized(String(advertised[..<yearRange.lowerBound]))
        guard !actual.isEmpty,expectedTitles.contains(where:{normalized($0)==actual}) else{throw StandaloneMovieIdentityFailure.title}
    }

    private static func literal(_ raw: String) throws -> String {
        let bytes = Array(raw.utf8)
        var output: [UInt8] = [], index = 0
        while index < bytes.count {
            let byte = bytes[index]; index += 1
            guard byte == 92 else { output.append(byte); continue }
            guard index < bytes.count else { throw Failure.changed }
            let escaped = bytes[index]; index += 1
            if escaped == 120 || escaped == 117 {
                let length = escaped == 120 ? 2 : 4
                guard index + length <= bytes.count,
                      let code = UInt32(String(decoding: bytes[index..<index+length], as: UTF8.self), radix: 16),
                      let scalar = UnicodeScalar(code) else { throw Failure.changed }
                output.append(contentsOf: String(scalar).utf8); index += length
            } else {
                let escapes: [UInt8: UInt8] = [110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 118: 11]
                output.append(escapes[escaped] ?? escaped)
            }
        }
        guard let value = String(bytes: output, encoding: .utf8) else { throw Failure.changed }
        return value
    }
}


enum StandaloneMovieIdentityFailure:LocalizedError {
    case unidentified,title,release(Int,Int)
    var errorDescription:String?{switch self{case .unidentified:"The provider did not identify this movie's release. Playback was not started.";case .title:"The provider returned a different movie. Playback was not started.";case .release(let actual,let expected):"The provider returned a different release (\(actual) instead of \(expected)). Playback was not started."}}
}

/// The same public XPS response protocol already used by the Mac MultiEmbed resolver.
/// The endpoint and returned stream remain bound to the requested movie; no page script executes.
enum StandaloneXPS {
    static func dataURL(html:String,contentID:Int,season:Int?=nil,episode:Int?=nil)throws->URL{
        guard contentID>0,(season==nil)==(episode==nil) else{throw StandaloneMovieIdentityFailure.unidentified}
        let expectedPath:String
        if let season,let episode{guard season>=0,episode>0 else{throw StandaloneMovieIdentityFailure.unidentified};expectedPath="/data/tv/\(contentID)/\(season)/\(episode)"}else{expectedPath="/data/movie/\(contentID)"}
        let regex=try NSRegularExpression(pattern:#"var\s+dataUrl\s*=\s*("(?:\\.|[^"\\])*")"#)
        guard html.utf8.count<=2_097_152,let found=regex.firstMatch(in:html,range:NSRange(html.startIndex...,in:html)),let range=Range(found.range(at:1),in:html),let raw=try JSONSerialization.jsonObject(with:Data(html[range].utf8),options:.fragmentsAllowed) as? String,let url=URL(string:raw,relativeTo:URL(string:"https://play.xpass.top")!)?.absoluteURL,url.scheme=="https",url.host=="play.xpass.top",url.user==nil,url.password==nil,url.port==nil || url.port==443,url.fragment==nil,url.path==expectedPath,URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems?.contains(where:{$0.name=="token" && !($0.value ?? "").isEmpty})==true else{throw StandaloneMovieIdentityFailure.unidentified}
        return url
    }
    static func backups(_ payload:Data,url:URL)throws->[[String:Any]]{
        guard payload.count<=2_097_152,let token=URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems?.first(where:{$0.name=="token"})?.value else{throw StandaloneMovieIdentityFailure.unidentified}
        var text=String(decoding:payload,as:UTF8.self).trimmingCharacters(in:.whitespacesAndNewlines).replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/");text+=String(repeating:"=",count:(4-text.count%4)%4)
        guard let data=Data(base64Encoded:text),data.count>=28 else{throw StandaloneMovieIdentityFailure.unidentified}
        let key=SymmetricKey(data:Data(SHA256.hash(data:Data(("spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|"+url.path+"|"+token).utf8))))
        let sealed=try AES.GCM.SealedBox(nonce:AES.GCM.Nonce(data:data.prefix(12)),ciphertext:data.dropFirst(12).dropLast(16),tag:data.suffix(16))
        let plain=try AES.GCM.open(sealed,using:key)
        guard let list=try JSONSerialization.jsonObject(with:plain) as? [[String:Any]],list.count<=64 else{throw StandaloneMovieIdentityFailure.unidentified};return list
    }
    static func clearDuration(_ playlist:String)throws->Double{
        guard playlist.utf8.count<=2_097_152,playlist.trimmingCharacters(in:.whitespacesAndNewlines).hasPrefix("#EXTM3U"),playlist.contains("#EXT-X-ENDLIST"),!playlist.contains("#EXT-X-KEY:"),!playlist.contains("#EXT-X-SESSION-KEY:") else{throw StandaloneMovieIdentityFailure.unidentified}
        let entries=playlist.components(separatedBy:.newlines).filter{$0.hasPrefix("#EXTINF:")}
        let values=entries.compactMap{$0.dropFirst(8).split(separator:",").first.flatMap{Double($0)}}
        let duration=values.reduce(0,+)
        guard !values.isEmpty,entries.count==values.count,values.allSatisfy({$0.isFinite && $0>0}),duration.isFinite,duration<=86400 else{throw StandaloneMovieIdentityFailure.unidentified}
        return duration
    }
    static func verifyDuration(_ playlist:String,expectedMinutes:Int)throws{
        let duration=try clearDuration(playlist)
        guard (1...1440).contains(expectedMinutes),abs(duration-Double(expectedMinutes*60))<=300 else{throw StandaloneMovieIdentityFailure.unidentified}
    }
}
