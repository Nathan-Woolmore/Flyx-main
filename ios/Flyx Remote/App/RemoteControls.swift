import SwiftUI
struct RemoteVolumeAction:Encodable {let id=UUID().uuidString;let type="volume";let output:String;let value:Double}
struct RemoteMuteAction:Encodable {let id=UUID().uuidString;let type="mute";let output:String;let value:Bool}
struct RemoteAction: Encodable { let id=UUID().uuidString;let type:String;var seconds:Double?;var receiverID:String? }
struct RemoteCastDevice: Decodable, Identifiable {let id:String;let name:String}
struct RemoteCastState: Decodable {let isConnected:Bool;let isCasting:Bool;let deviceName:String?}
struct RemoteCastResult: Decodable {let ok:Bool;let devices:[RemoteCastDevice]?;let castState:RemoteCastState?}
struct RemoteDownload: Decodable,Identifiable {let id:String;let label:String;let status:String;let progress:Double;let bytes:Int64;let canRetry:Bool;let error:String?}
struct RemoteDownloadList: Decodable {let jobs:[RemoteDownload]}
struct RemoteOK:Decodable {let ok:Bool}
struct DownloadOperation:Encodable {let operation:String;let id:String}
struct VideoDownload:Encodable {let kind="video";let tmdbId:Int;let mediaType:String;let malId:Int?;let season:Int?;let episode:Int?;let title:String;var quality:String?=nil}
struct QueueDownload:Encodable {let operation="queue";let item:VideoDownload}
extension RemoteClient {
 func action(_ type:String,seconds:Double?=nil) async throws -> CommandResult {try await request("/remote/v1/commands",body:JSONEncoder().encode(RemoteAction(type:type,seconds:seconds)))}
 func cast(_ type:String,receiverID:String?=nil) async throws -> RemoteCastResult {try await request("/remote/v1/commands",body:JSONEncoder().encode(RemoteAction(type:type,receiverID:receiverID)))}
 func download(_ item:RemoteTitle,season:Int?,episode:Int?,quality:String?=nil) async throws -> RemoteOK {
  guard let id=Int(item.id) else {throw RemoteFailure(message:"Video download unavailable")}
  let body=QueueDownload(item:VideoDownload(tmdbId:item.kind == "anime" ? 0:id,mediaType:item.kind == "movie" ? "movie":"tv",malId:item.kind == "anime" ? id:nil,season:season,episode:episode,title:item.title,quality:quality))
  return try await request("/remote/v1/downloads",body:JSONEncoder().encode(body))
 }
}
struct RemoteHomeView:View {
 let client:RemoteClient
 @State private var watchlist=RemoteWatchlist()
 @State private var playback=PlaybackSession()
 var body:some View {TabView {
  Tab("Browse",systemImage:"square.grid.2x2"){RemoteLibraryView(client:client,watchlist:watchlist)}
  Tab("Watchlist",systemImage:"bookmark"){RemoteWatchlistView(client:client,model:watchlist)}
  Tab("Remote",systemImage:"play.rectangle"){RemoteControlView(client:client)}
  if client.scopes.contains("downloads.read") {Tab("Downloads",systemImage:"arrow.down.circle"){RemoteDownloadsView(client:client)}}
 }.environment(\.playbackSession,playback).task{await watchlist.refresh(client)}}
}
struct RemoteDownloadsView:View {
 let client:RemoteClient
 @State private var jobs:[RemoteDownload]=[]
 @State private var error:String?
 @State private var busy=false
 var body:some View {NavigationStack {List {
  ForEach(jobs){job in VStack(alignment:.leading,spacing:8){Text(job.label).font(.headline);Text(job.status.capitalized);ProgressView(value:job.progress,total:100);if let error=job.error{Text(error).foregroundStyle(.orange)}
   if client.scopes.contains("downloads.write") {HStack {Button(["queued","downloading","processing"].contains(job.status) ? "Cancel":"Remove history"){mutate("remove",job:job)};if job.canRetry{Button("Retry"){mutate("retry",job:job)}}}.buttonStyle(.bordered).disabled(busy)}
  }}
  if let error{Text(error).foregroundStyle(.orange)}
 }.navigationTitle("Mac downloads").overlay{if jobs.isEmpty && error == nil{ContentUnavailableView("No downloads",systemImage:"arrow.down.circle")}}.refreshable{await refresh()}.task{while !Task.isCancelled{await refresh();try? await Task.sleep(for:.seconds(5))}}}}
 private func refresh()async{do{let result:RemoteDownloadList=try await client.request("/remote/v1/downloads");jobs=result.jobs;error=nil}catch{if !Task.isCancelled{self.error=error.localizedDescription}}}
 private func mutate(_ operation:String,job:RemoteDownload){busy=true;Task{defer{busy=false};do{let _:RemoteOK=try await client.request("/remote/v1/downloads",body:JSONEncoder().encode(DownloadOperation(operation:operation,id:job.id)));await refresh()}catch{self.error=error.localizedDescription}}}
}
