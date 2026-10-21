#if DEBUG
import SwiftUI
@preconcurrency import AVKit
@MainActor struct NativeProgressFixture:View {
 let client:RemoteClient;let mode:String
 @Environment(\.scenePhase) private var phase
 @State private var phone=PhonePlaybackModel()
 @State private var result="Checking native progress…"
 var body:some View{Text(result).padding().onChange(of:phase){_,value in if value != .active{phone.recordProgress(client,force:true);UIOnlyProtocol.probe(["nativeBackgroundFlushRequested":true])}}.task{await run()}}
 private func summary()async throws->SeriesProgress?{let value:ProgressReply=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"read",selection:.init(kind:"movie",contentID:1,season:nil,episode:nil))));return value.entry}
 private func run()async{phone.progress.enabled=true
  do{
   if mode=="native-progress-end"{
    await phone.prepare(client,selection:.init(kind:"movie",contentID:1,season:nil,episode:nil),position:0);guard phone.ready else{throw RemoteFailure(message:phone.error ?? "Native ending prepare failed")}
    let deadline=ContinuousClock.now.advanced(by:.seconds(10))
    while ContinuousClock.now<deadline{phone.recordProgress(client);if phone.player.currentTime().seconds>=5.9,phone.player.rate==0{break};try await Task.sleep(for:.milliseconds(250))}
    await phone.flushProgress(client);guard let entry=try await summary(),entry.completed,entry.duration==6 else{throw RemoteFailure(message:"Natural AVPlayer ending did not persist completion")};UIOnlyProtocol.probe(["nativeNaturalEndingCompleted":true,"nativeNaturalEndingPosition":entry.position,"nativeNaturalEndingDuration":entry.duration]);phone.stop(client);result="Natural native ending recorded."
   }else if mode=="native-progress-save"{
    await phone.prepare(client);guard phone.ready else{throw RemoteFailure(message:phone.error ?? "Native prepare failed")}
    phone.player.pause();try await phone.seekTransfer(to:40);await phone.flushProgress(client)
    guard let entry=try await summary(),abs(entry.position-40)<0.05,!entry.completed else{throw RemoteFailure(message:"Native pause did not persist exact position")}
    UIOnlyProtocol.probe(["nativeProgressPauseSaved":true,"nativeProgressPausePosition":entry.position]);try await phone.seekTransfer(to:45);result="Native pause saved. Ready for background flush.";UIOnlyProtocol.probe(["nativeReadyForBackground":true])
   }else{
    guard let saved=try await summary(),abs(saved.position-45)<0.05 else{throw RemoteFailure(message:"Background/restart position was not45s")}
    await phone.prepare(client,selection:.init(kind:"movie",contentID:1,season:nil,episode:nil),position:saved.position);phone.player.pause();guard phone.ready,abs(phone.player.currentTime().seconds-45)<0.05 else{throw RemoteFailure(message:"Native resume did not restore45s")};await phone.flushProgress(client);UIOnlyProtocol.probe(["nativeProgressRestartResume":true,"nativeProgressResumePosition":phone.player.currentTime().seconds])
    let title=RemoteTitle(id:"1",kind:"movie",title:"Synthetic clip",overview:"",posterURL:nil);let ack=try await client.play(title,season:nil,episode:nil,seconds:0);guard ack.ok,ack.status.position==0 else{throw RemoteFailure(message:"Mac start-over was not acknowledged at0")}
    await phone.prepare(client,selection:.init(kind:"movie",contentID:1,season:nil,episode:nil),position:0);phone.player.pause();await phone.flushProgress(client);guard phone.ready,phone.player.currentTime().seconds<0.1,let reset=try await summary(),reset.position<0.1 else{throw RemoteFailure(message:"Native start-over did not persist0")};UIOnlyProtocol.probe(["nativeStartOverPhone":true,"nativeStartOverMac":true,"nativeStartOverStoredPosition":reset.position])
    let _:RemoteOK=try await client.request("/remote/v1/fixture-newer",body:Data("{}".utf8));try await phone.seekTransfer(to:20);await phone.flushProgress(client);guard let newer=try await summary(),newer.position==70,phone.progress.warning != nil else{throw RemoteFailure(message:"Stale native write overwrote newer Mac progress")};UIOnlyProtocol.probe(["nativeStaleWriteRejected":true,"nativeNewerMacPosition":newer.position]);phone.stop(client);result="Native resume, start-over and stale-write tests passed."
   }
  }catch{result=error.localizedDescription;UIOnlyProtocol.probe(["nativeProgressError":error.localizedDescription])}
 }
}
#endif
