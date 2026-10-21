import Foundation
import Observation
import UIKit

struct ProgressOperation:Encodable,Sendable {let operation:String;var selection:PhonePlaybackSelection?;var handle:String?;var sessionID:String?;var sequence:Int?;var position:Double?;var duration:Double?;var ended:Bool?}
struct ProgressLease:Decodable{let sessionID:String}
struct ProgressReply:Decodable{let entry:SeriesProgress?}
struct SeriesProgress:Decodable,Sendable {let kind:String;let contentID:Int;let season:Int;let episode:Int;let position:Double;let duration:Double;let completed:Bool;let lastWatchedAt:Double}
@MainActor @Observable final class RemoteProgressRecorder {
    var enabled=false
    private(set) var warning:String?
    @ObservationIgnored private(set) var task:Task<Void,Never>?
    private struct Sample{let handle:String;let position:Double;let duration:Double;let ended:Bool}
    private var queued:Sample?
    private var lease:String?
    private var leaseHandle:String?
    private var sequence=0
    private var lastSent=Date.distantPast
    private var backgroundID:UIBackgroundTaskIdentifier = .invalid
    func record(_ client:RemoteClient,handle:String,position:Double,duration:Double,ended:Bool=false,force:Bool=false){
        guard enabled,position.isFinite,position>=0,duration.isFinite,duration>0,force || Date().timeIntervalSince(lastSent)>=5 else{return}
        if force,UIApplication.shared.applicationState != .active,backgroundID == .invalid{backgroundID=UIApplication.shared.beginBackgroundTask(withName:"Save Flyx progress"){[weak self] in Task{@MainActor in self?.task?.cancel();self?.endBackground()}}}
        lastSent=Date();queued=Sample(handle:handle,position:position,duration:duration,ended:ended)
        guard task==nil else{return};task=Task{await pump(client)}
    }
    private func endBackground(){if backgroundID != .invalid{UIApplication.shared.endBackgroundTask(backgroundID);backgroundID = .invalid}}
    private func pump(_ client:RemoteClient)async {
        defer{task=nil;endBackground()}
        while let sample=queued {
            queued=nil
            do{
                if lease==nil || leaseHandle != sample.handle {let value:ProgressLease=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"begin",handle:sample.handle)));lease=value.sessionID;leaseHandle=sample.handle;sequence=0}
                sequence+=1
                let _:RemoteOK=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"update",sessionID:lease,sequence:sequence,position:sample.position,duration:sample.duration,ended:sample.ended)))
                warning=nil
            }catch{warning=client.isStandalone ? "Progress could not be saved on this iPhone.":"Progress could not be saved to the Mac. Keep Flyx connected before leaving this episode."}
        }
    }
}
