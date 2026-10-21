import SwiftUI
import Observation
@preconcurrency import AVFoundation

/// One playback owner per paired connection, shared by Browse detail covers and
/// the Watch tab. Closing a control surface does not retire its AVPlayer.
@MainActor @Observable final class PlaybackSession {
    let phone=PhonePlaybackModel()
    let directCast=StandaloneCastModel()
    let transfer=DestinationTransferModel()
    var selectedTab="home"
    var phoneActive=false
    var controlClient:RemoteClient?
    func macBecameUnavailable(_ client:RemoteClient){
        // Retain remote output/title/position and its client; never load it on the phone.
        if retainsPlaybackContext{controlClient=controlClient ?? client}
        epoch+=1;remoteReadID=nil;refreshInFlight=false
        foregroundWork?.cancel();foregroundWork=nil;workTask?.cancel()
        connectionMessage="Mac unavailable · showing last known playback"
    }
    private(set) var preparingOutput:String?
    var currentOutput:String{phoneActive ? "phone":status?.output ?? "mac"}
    func displayedOutput(initialPhoneRequest:Bool=false)->String{preparingOutput ?? (initialPhoneRequest ? "phone":currentOutput)}
    func acceptsRemoteStatus(epoch ticket:Int)->Bool{ticket==epoch && !appInBackground && !phoneActive && !busy && preparingOutput==nil}
    private(set) var appInBackground=false
    private(set) var connectionMessage:String?
    private var sceneGeneration=0
    private var awaitingIdleConfirmation=false
    private var remoteReadID:UUID?
    @ObservationIgnored private var foregroundWork:Task<Void,Never>?
    var retainsPlaybackContext:Bool{phoneActive || status.map{!["idle","stopped"].contains($0.state)} == true || preparingOutput != nil || transfer.pending}
    var status:PlaybackStatus?
    var busy=false
    var error:String?
    var transferV2=false
    var macSourcesSupported=false
    var macSources:[MacSourceChoice]=[]
    var phoneArtwork:String?
    var epoch=0
    var refreshInFlight=false
    var handledPresentations:Set<UUID>=[]
    func applicationDidBackground(_ client:RemoteClient){
        guard !appInBackground else{return};appInBackground=true;sceneGeneration+=1;epoch+=1
        foregroundWork?.cancel();foregroundWork=nil;remoteReadID=nil;refreshInFlight=false
        if phoneActive{phone.applicationDidBackground(client)}
    }
    func applicationDidBecomeActive(_ client:RemoteClient)async{
        if let foregroundWork{await foregroundWork.value;return}
        if !appInBackground{if !phoneActive{await refreshRemoteStatus(controlClient ?? client)};return}
        appInBackground=false;sceneGeneration+=1;epoch+=1;awaitingIdleConfirmation=retainsPlaybackContext
        let ticket=sceneGeneration
        let work=Task{[weak self] in guard let self else{return}
            if self.phoneActive{await self.phone.applicationDidBecomeActive(client)}
            guard !Task.isCancelled,ticket==self.sceneGeneration,!self.appInBackground else{return}
            if !self.phoneActive{await self.refreshRemoteStatus(self.controlClient ?? client)}
        }
        foregroundWork=work;await work.value;if ticket==sceneGeneration{foregroundWork=nil}
    }
    func refreshRemoteStatus(_ client:RemoteClient)async{
        guard !client.isStandalone,!appInBackground,!phoneActive,!busy,preparingOutput==nil,remoteReadID==nil else{return}
        let id=UUID(),ticket=epoch;remoteReadID=id;refreshInFlight=true
        defer{if remoteReadID==id{remoteReadID=nil;refreshInFlight=false}}
        do{
            let value:PlaybackStatus=try await client.request("/remote/v1/status")
            guard acceptsRemoteStatus(epoch:ticket),remoteReadID==id,!Task.isCancelled else{return}
            if awaitingIdleConfirmation,["idle","stopped"].contains(value.state),retainsPlaybackContext{awaitingIdleConfirmation=false;connectionMessage="Refreshing playback on Mac…";return}
            awaitingIdleConfirmation=false;status=value;connectionMessage=nil;controlClient=retainsPlaybackContext ? client:nil
        }catch is CancellationError{}catch{
            guard acceptsRemoteStatus(epoch:ticket),remoteReadID==id,!Task.isCancelled else{return}
            if let failure=error as? RemoteFailure,[401,403].contains(failure.status ?? 0){connectionMessage=failure.message}
            else{connectionMessage="Reconnecting to Mac · showing last known playback"}
        }
    }
    var audioAvailable:Bool{phoneActive || directCast.active || status?.audioControl==true}
    var audioMuted:Bool{phoneActive ? phone.player.isMuted:directCast.active ? directCast.muted:status?.isMuted==true}
    var audioVolume:Double{phoneActive ? Double(phone.player.volume):directCast.active ? directCast.volume:status?.volume ?? 0}
    private func requireControl()throws{guard preparingOutput==nil,!appInBackground,phoneActive ? phone.ready:directCast.active || connectionMessage==nil else{throw RemoteFailure(message:"Wait for the current destination to be ready.")}}
    func setVolume(_ client:RemoteClient,_ value:Double)async throws{
        try requireControl();guard audioAvailable,value.isFinite else{throw RemoteFailure(message:"Volume is unavailable on this output.")};let value=min(1,max(0,value))
        if phoneActive{phone.player.volume=Float(value)}else if directCast.active{try directCast.setVolume(value)}else{let result:CommandResult=try await client.request("/remote/v1/commands",body:JSONEncoder().encode(RemoteVolumeAction(output:currentOutput,value:value)));status=result.status}
    }
    func setMuted(_ client:RemoteClient,_ value:Bool)async throws{
        try requireControl();guard audioAvailable else{throw RemoteFailure(message:"Audio changes are unavailable on this output.")}
        if phoneActive{phone.player.isMuted=value}else if directCast.active{try directCast.setMuted(value)}else{let result:CommandResult=try await client.request("/remote/v1/commands",body:JSONEncoder().encode(RemoteMuteAction(output:currentOutput,value:value)));status=result.status}
    }
    func run(_ work:@escaping @MainActor ()async throws->Void) {
        guard !busy else{return};busy=true;epoch+=1;error=nil
        workTask=Task{defer{busy=false;workTask=nil;epoch+=1};do{try await work()}catch{if !Task.isCancelled{self.error=error.localizedDescription}}}
    }
    func startPhone(_ client:RemoteClient,presentationID:UUID,selection:PhonePlaybackSelection?,position:Double?,item:RemoteTitle?=nil){
        guard !busy,!handledPresentations.contains(presentationID) else{return}
        handledPresentations.insert(presentationID);controlClient=client
        if client.isStandalone{directCast.end()}
        // Selecting a new phone title owns the local controls immediately; Mac status is unrelated.
        phoneActive=true;phoneArtwork=item?.posterURL;phone.title=item?.title ?? "This iPhone"
        preparingOutput="phone"
        run{defer{self.preparingOutput=nil}
            await self.phone.prepare(client,selection:selection,position:position)
            try Task.checkCancellation()
            guard self.phone.ready else{throw RemoteFailure(message:self.phone.error ?? "Could not prepare playback on this iPhone.")}
        }
    }
    func cancel(_ client:RemoteClient){
        directCast.end();transfer.cancel(client);workTask?.cancel()
        if preparingOutput=="phone",!transfer.pending{phone.stop(client)}
    }
    func switchLegacyOutput(_ client:RemoteClient,to destination:String)async throws{
        guard preparingOutput==nil else{throw RemoteFailure(message:"A destination is already being prepared.")}
        preparingOutput=destination;epoch+=1;defer{preparingOutput=nil}
        if destination=="phone"{
            guard status?.output != "tv" else{throw RemoteFailure(message:"TV → iPhone transfer is not supported by this bridge.")}
            await phone.prepare(client);try Task.checkCancellation()
            guard phone.ready else{throw RemoteFailure(message:phone.error ?? "iPhone preparation failed. The current output is unchanged.")}
            phoneActive=true
        }else{
            guard phoneActive else{throw RemoteFailure(message:"TV → Mac transfer requires the new Mac transfer bridge.")}
            guard await phone.returnToMac(client) else{throw RemoteFailure(message:phone.error ?? "Mac did not confirm the transfer. iPhone playback continues.")}
            try Task.checkCancellation();phone.stop(client);phoneActive=false
        }
        epoch+=1
    }
    func playbackAction(_ client:RemoteClient,_ type:String,seconds:Double?=nil)async throws{
        guard preparingOutput==nil else{throw RemoteFailure(message:"Wait for destination preparation to finish.")}
        guard phoneActive || connectionMessage==nil else{throw RemoteFailure(message:"Wait for Mac playback to reconnect.")}
        if client.isStandalone,directCast.active{directCast.action(type,seconds:seconds);return}
        if phoneActive{
            let raw=phone.player.currentItem?.duration.seconds ?? 0,duration=raw.isFinite ? max(0,raw):0
            switch type{
            case "pause":phone.notePaused(true);phone.player.pause()
            case "resume":phone.notePaused(false);phone.player.play()
            case "stop":phone.notePaused(true);phone.player.pause();guard await phone.player.seek(to:.zero) else{throw RemoteFailure(message:"iPhone seek failed.")}
            case "seek":guard let seconds,await phone.player.seek(to:CMTime(seconds:max(0,min(duration,seconds)),preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) else{throw RemoteFailure(message:"iPhone seek failed.")}
            default:throw RemoteFailure(message:"Unsupported player control.")
            }
            phone.recordProgress(client,force:true)
        }else{
            let ticket=epoch,value=try await client.action(type,seconds:seconds).status
            try Task.checkCancellation();guard ticket==epoch,!phoneActive else{return};status=value
        }
    }
    func switchOutput(_ client:RemoteClient,to destination:String,receiverID:String?=nil)async throws {
        guard preparingOutput==nil else{throw RemoteFailure(message:"A destination is already being prepared.")}
        preparingOutput=destination;epoch+=1;defer{preparingOutput=nil}
        if phoneActive{await phone.flushProgress(client)}
        let origin=phoneActive ? "phone":(status?.output=="tv" ? "tv":"mac")
        let duration=phoneActive ? phone.player.currentItem?.duration.seconds:status?.duration
        let title=phoneActive ? phone.title:status?.title ?? "Now Playing"
        let artwork=phoneActive ? phoneArtwork:status?.artworkURL
        let ack=try await transfer.transfer(client,origin:origin,destination:destination,receiverID:receiverID,phone:phone,title:title)
        phoneActive=ack.output=="phone";epoch+=1
        if ack.output=="tv"{selectedTab="remote"}
        if phoneActive{phoneArtwork=artwork}else{status=PlaybackStatus(state:ack.paused ? "paused":"playing",position:ack.position,duration:duration?.isFinite==true ? duration!:0,title:title,artworkURL:artwork,output:ack.output,outputName:ack.output=="tv" ? "TV":"Mac")}
    }
    @ObservationIgnored var workTask:Task<Void,Never>?
}
private struct PlaybackSessionKey:EnvironmentKey {static let defaultValue:PlaybackSession?=nil}
extension EnvironmentValues {var playbackSession:PlaybackSession?{get{self[PlaybackSessionKey.self]}set{self[PlaybackSessionKey.self]=newValue}}}
