import Foundation

enum RemoteCompatibility {
    static func message(path:String,status:Int,code:String?)->String? {
        guard status==404,code==nil || code=="UNSUPPORTED_OPERATION" else{return nil}
        let feature:String
        if path.hasPrefix("/remote/v1/manga/"){feature="read manga"}
        else if path=="/remote/v1/watchlist"{feature="use its Watchlist"}
        else if (path=="/remote/v1/media" || path.hasPrefix("/remote/v1/media/")) || path=="/remote/v1/handoff"{feature="play on this iPhone"}
        else{return nil}
        return "Update Flyx on your Mac to \(feature). Your saved connection can stay paired."
    }
}
