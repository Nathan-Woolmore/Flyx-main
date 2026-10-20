#if DEBUG
import Foundation

extension StandaloneService {
    /// Entirely inert policy checks: fixture.invalid is intercepted before any network call.
    func debugFallbackChecks()async->Data{
        var result:[String:Any]=[:]
        let second=StandaloneSource(url:URL(string:"https://fixture.invalid/second.m3u8")!,headers:[:],format:"hls",provider:"Fixture 502",quality:"Synthetic",language:"")
        for status in [403,502] {
            let first=StandaloneSource(url:URL(string:"https://fixture.invalid/first.m3u8")!,headers:[:],format:"hls",provider:status==403 ? "Fixture 403":"Fixture 502",quality:"Synthetic",language:"")
            let id=UUID().uuidString
            media[id]=StandaloneMediaSession(selection:["contentID":1,"season":1,"episode":1],kind:"movie",title:"Inert policy check",sources:[first,second],resources:["0":first.url])
            let before=debugNetworkRequests
            do{_ = try await request("/remote/v1/media",query:[],body:JSONSerialization.data(withJSONObject:["operation":"resource","handle":id,"resourceID":"0"]))}catch{}
            do {
                _ = try await request("/remote/v1/media",query:[],body:JSONSerialization.data(withJSONObject:["operation":"next-source","handle":id]))
                result["outageAllowsOneFallback"]=status==502 && media[id]?.index==1
                do{_ = try await request("/remote/v1/media",query:[],body:JSONSerialization.data(withJSONObject:["operation":"next-source","handle":id]));result["fallbackBounded"]=false}catch{result["fallbackBounded"]=true}
            }catch{if status==403{result["refusalStopsFallback"]=(error as? RemoteFailure)?.status==403 && media[id]?.index==0}}
            result["networkRequestsFor"+String(status)]=debugNetworkRequests-before
            media.removeValue(forKey:id);mediaFailures.removeValue(forKey:id)
        }
        return (try? JSONSerialization.data(withJSONObject:result)) ?? Data()
    }
}
#endif
