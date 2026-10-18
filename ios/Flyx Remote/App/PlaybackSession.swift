import SwiftUI
import Observation

/// One playback owner per paired connection, shared by Browse detail covers and
/// the Remote tab. Closing a control surface does not retire its AVPlayer.
@MainActor @Observable final class PlaybackSession {
    let phone=PhonePlaybackModel()
    let transfer=DestinationTransferModel()
    var selectedTab="browse"
    var phoneActive=false
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
    func run(_ work:@escaping @MainActor ()async throws->Void) {
        guard !busy else{return};busy=true;epoch+=1;error=nil
        workTask=Task{defer{busy=false;workTask=nil;epoch+=1};do{try await work()}catch{if !Task.isCancelled{self.error=error.localizedDescription}}}
    }
    func cancel(_ client:RemoteClient){transfer.cancel(client);workTask?.cancel()}
    func switchOutput(_ client:RemoteClient,to destination:String,receiverID:String?=nil)async throws {
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
