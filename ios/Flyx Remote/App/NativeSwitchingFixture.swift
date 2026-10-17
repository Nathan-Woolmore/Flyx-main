#if DEBUG
import SwiftUI
@preconcurrency import AVKit
@MainActor struct NativeSwitchingFixture:View {
 let client:RemoteClient
 @State private var session=PlaybackSession()
 @State private var presented=false
 @State private var result="Running native controller integration…"
 var body:some View{VStack(spacing:24){Text(result);Button("Open shared controls"){presented=true};Button("Prepare slow handoff test"){Task{try? await mode("slow");presented=true}}}.padding().environment(\.playbackSession,session).fullScreenCover(isPresented:$presented){RemoteControlView(client:client,showClose:true).environment(\.playbackSession,session)}.task{await run()}}
 private func mode(_ value:String)async throws{struct Mode:Encodable{let mode:String};let _:RemoteOK=try await client.request("/remote/v1/fixture-mode",body:JSONEncoder().encode(Mode(mode:value)))}
 private func require(_ condition:Bool,_ message:String)throws{if !condition{throw RemoteFailure(message:message)}}
 private func run()async{do{
  session.transferV2=true;session.status=try await client.request("/remote/v1/status")
  for _ in 0..<4 {
   try await session.switchOutput(client,to:"phone");try require(session.phoneActive && session.phone.ready,"Phone ownership missing")
   session.phone.player.pause();try await session.phone.seekTransfer(to:33.25)
   try await session.switchOutput(client,to:"mac");try require(!session.phoneActive && !session.phone.ready && abs((session.status?.position ?? -1)-33.25)<0.05,"Mac ownership/position missing")
  };UIOnlyProtocol.probe(["switch40RepeatedRoundTrips":4])
  try await mode("lost-confirm");try await session.switchOutput(client,to:"phone");try require(session.phoneActive && session.phone.ready,"Lost confirmation did not reconcile authoritative owner");UIOnlyProtocol.probe(["switch40LostConfirmReconciled":true]);try await session.switchOutput(client,to:"mac")
  try await mode("failed-phone");do{try await session.switchOutput(client,to:"phone");throw RemoteFailure(message:"Failed phone source unexpectedly succeeded")}catch{try require(!session.phoneActive && !session.phone.ready,"Failed phone source changed owner")};UIOnlyProtocol.probe(["switch40FailedPhonePreservedOrigin":true])
  try await mode("normal");try await session.switchOutput(client,to:"phone")
  let native=session.phone.player
  try await mode("failed-mac");do{try await session.switchOutput(client,to:"mac");throw RemoteFailure(message:"Failed Mac source unexpectedly succeeded")}catch{try require(session.phoneActive && session.phone.ready && session.phone.player===native,"Failed Mac source retired native phone")};UIOnlyProtocol.probe(["switch40FailedMacPreservedOrigin":true])
  try await mode("slow-mac");session.run{try await session.switchOutput(client,to:"mac")};session.run{throw RemoteFailure(message:"Duplicate task admitted")};try await Task.sleep(for:.milliseconds(100));session.cancel(client)
  let deadline=ContinuousClock.now.advanced(by:.seconds(10));while session.busy{try require(ContinuousClock.now<deadline,"Cancellation did not settle");try await Task.sleep(for:.milliseconds(50))}
  try require(session.phoneActive && session.phone.ready && session.phone.player===native && session.error==nil,"Cancellation/repeat changed origin or created duplicate owner");UIOnlyProtocol.probe(["switch40CancelRollbackConfirmed":true,"switch40DuplicateWorkRejected":true])
  try await mode("normal");try await session.switchOutput(client,to:"mac");result="Native controller tests passed. Open shared controls for Done/reopen/rotation QA.";UIOnlyProtocol.probe(["switch40NativeIntegrationPassed":true,"switch40NativeIntegrationError":"none"])
 }catch{result=error.localizedDescription;UIOnlyProtocol.probe(["switch40NativeIntegrationPassed":false,"switch40NativeIntegrationError":error.localizedDescription])}}
}
#endif
