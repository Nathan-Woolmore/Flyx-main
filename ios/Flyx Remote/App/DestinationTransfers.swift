import Foundation
import Observation
@preconcurrency import AVKit

struct DestinationTransferOperation: Encodable, Sendable {
    let operation:String
    let id:String
    var origin:String?
    var destination:String?
    var receiverID:String?
    var phoneHandle:String?
    var position:Double?
    var paused:Bool?
    var nativeReady:Bool?
}
struct DestinationTransferStatus:Decodable,Sendable {let identity:String;let position:Double;let paused:Bool;let output:String}
struct DestinationTransferData:Decodable,Sendable {let handle:String;let format:String;let position:Double;let duration:Double;let paused:Bool;var sourceInfo:PlaybackSourceInfo?}
struct DestinationTransferResult:Decodable,Sendable {var id:String?;let phase:String;var status:DestinationTransferStatus?;var destinationData:DestinationTransferData?;var rollbackConfirmed:Bool?}

/// UI-owned transaction lifetime. The ID exists before the first request so a
/// cancelled prepare can still be retired after its network reply is lost.
@MainActor @Observable final class DestinationTransferModel {
    private(set) var pending=false
    @ObservationIgnored private var ticket:UUID?
    @ObservationIgnored private var cancellation:Task<DestinationTransferResult?,Never>?
    @ObservationIgnored private var currentID:String?
    private func request(_ client:RemoteClient,_ body:DestinationTransferOperation)async throws->DestinationTransferResult {
        try await client.request("/remote/v1/transfers",body:JSONEncoder().encode(body))
    }
    func cancel(_ client:RemoteClient) {
        ticket=nil
        guard let id=currentID else{return}
        currentID=nil
        // This cleanup must survive SwiftUI's cancelled task. The immutable
        // client and transaction ID are the only values sent off the UI actor.
        cancellation=Task.detached(priority:.utility){
            let body=try? JSONEncoder().encode(DestinationTransferOperation(operation:"cancel",id:id))
            let result:DestinationTransferResult?=try? await client.request("/remote/v1/transfers",body:body)
            return result
        }
    }
    func transfer(_ client:RemoteClient,origin:String,destination:String,receiverID:String?=nil,phone:PhonePlaybackModel,title:String)async throws->DestinationTransferStatus {
        guard !pending else{throw RemoteFailure(message:"A destination is already being prepared.")}
        let generation=UUID(),id=UUID().uuidString
        ticket=generation;currentID=id;pending=true
        let originalPhonePaused=phone.player.rate==0
        var phoneWasPaused=false
        defer{pending=false;if currentID==id{currentID=nil}}
        func valid()throws{try Task.checkCancellation();guard ticket==generation else{throw CancellationError()}}
        do {
            let initial=origin=="phone" ? try phone.transferSnapshot():nil
            let prepared=try await request(client,.init(operation:"prepare",id:id,origin:origin,destination:destination,receiverID:receiverID,phoneHandle:initial?.handle,position:initial?.position,paused:initial?.paused))
            try valid();guard prepared.phase=="prepared" else{throw RemoteFailure(message:"The Mac did not prepare this destination.")}
            if destination=="phone" {
                guard let data=prepared.destinationData else{throw RemoteFailure(message:"The Mac did not provide iPhone media access.")}
                try await phone.stageTransfer(client,data:data,title:title);try valid()
            }
            let latest=origin=="phone" ? try phone.transferSnapshot():nil
            var committed=try await request(client,.init(operation:"commit",id:id,position:latest?.position,paused:latest?.paused,nativeReady:destination=="phone" ? true:nil))
            try valid()
            if destination=="phone" {
                guard committed.phase=="awaiting-native-confirm",let status=committed.status else{throw RemoteFailure(message:"The Mac did not confirm the iPhone transfer.")}
                try await phone.seekTransfer(to:status.position);try valid()
                committed=try await request(client,.init(operation:"confirm",id:id,position:phone.player.currentTime().seconds,nativeReady:true))
            } else if origin=="phone",committed.phase=="awaiting-origin-confirm" {
                // The destination has acknowledged readiness. Freeze the origin
                // now and send its actual final position, rather than the time
                // captured before a potentially slow receiver request.
                phone.player.pause();phoneWasPaused=true
                let final=try phone.transferSnapshot(paused:originalPhonePaused)
                try valid()
                committed=try await request(client,.init(operation:"confirm",id:id,position:final.position,paused:originalPhonePaused,nativeReady:true))
            }
            try valid();guard committed.phase=="committed",let status=committed.status else{throw RemoteFailure(message:"The destination did not confirm playback. The original output is being restored.")}
            if destination=="phone"{phone.finishTransfer(paused:status.paused)}else if origin=="phone"{phone.stop(client)}
            ticket=nil;return status
        } catch {
            let body=DestinationTransferOperation(operation:"cancel",id:id)
            let cleanup=Task.detached(priority:.utility){()->DestinationTransferResult? in
                var result:DestinationTransferResult?=try? await client.request("/remote/v1/transfers",body:JSONEncoder().encode(body))
                // Cancellation may reach the server while native preparation is
                // still unwinding. Keep the transaction busy until rollback is
                // acknowledged, rather than allowing an overlapping retry.
                let deadline=ContinuousClock.now.advanced(by:.seconds(22))
                while let value=result,value.phase != "committed",value.rollbackConfirmed != true,ContinuousClock.now<deadline {
                    try? await Task.sleep(for:.milliseconds(100))
                    result=try? await client.request("/remote/v1/transfers",body:JSONEncoder().encode(DestinationTransferOperation(operation:"status",id:id)))
                }
                return result
            }
            let result=await cleanup.value
            _ = await cancellation?.value
            if result?.phase=="committed" {
                // A lost confirmation reply is an acknowledged transfer, never
                // a reason to start the old output again.
                if destination=="phone",let status=result?.status{phone.finishTransfer(paused:status.paused)}
                else if origin=="phone"{phone.stop(client)}
                if let status=result?.status{ticket=nil;return status}
            } else {
                if destination=="phone"{phone.stop(client)}
                if origin=="phone",phoneWasPaused,!originalPhonePaused,result?.rollbackConfirmed==true{phone.player.play()}
            }
            ticket=nil
            if result==nil || (result?.phase != "committed" && result?.rollbackConfirmed != true){throw RemoteFailure(message:"Transfer outcome could not be confirmed. Check both outputs before retrying.")}
            throw error
        }
    }
}
