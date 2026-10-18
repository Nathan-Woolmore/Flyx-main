import SwiftUI
struct RemoteVolumeAction:Encodable {let id=UUID().uuidString;let type="volume";let output:String;let value:Double}
struct RemoteMuteAction:Encodable {let id=UUID().uuidString;let type="mute";let output:String;let value:Bool}
struct RemoteAction: Encodable { let id=UUID().uuidString;let type:String;var seconds:Double?;var receiverID:String? }
struct RemoteCastDevice: Decodable, Identifiable {let id:String;let name:String}
struct RemoteCastState: Decodable {let isConnected:Bool;let isCasting:Bool;let deviceName:String?}
struct RemoteCastResult: Decodable {let ok:Bool;let devices:[RemoteCastDevice]?;let castState:RemoteCastState?}
struct RemoteDownload: Decodable,Equatable,Identifiable {
 let id:String;let label:String;let status:String;let progress:Double;let bytes:Int64;let canRetry:Bool;let error:String?
 var canTrash:Bool?;var fileRevision:String?
 var kind:String?;var totalBytes:Int64?;var quality:String?;var selection:PhonePlaybackSelection?;var localPlaybackAvailable:Bool?;var removalClearsCache:Bool?;var title:RemoteTitle?
 var active:Bool{["queued","downloading","processing"].contains(status)}
 var playable:Bool{status=="done" && localPlaybackAvailable==true && selection != nil}
 var displayTitle:RemoteTitle{title ?? RemoteTitle(id:selection.map{String($0.contentID)} ?? id,kind:selection?.kind ?? kind ?? "movie",title:label,overview:"",posterURL:nil)}
 var episodeLabel:String?{guard let s=selection,s.kind != "movie",let episode=s.episode else{return nil};return s.kind=="anime" ? "Episode \(episode)":"S\(s.season ?? 1) · E\(episode)"}
 var stateLabel:String{switch status{case "done":return playable ? "Downloaded":"File unavailable";case "queued":return "Queued";case "downloading":return "Downloading · \(Int(progress))%";case "processing":return "Finishing…";case "error":return "Download failed";case "cancelled":return "Cancelled";default:return status.capitalized}}
}
struct RemoteDownloadList: Decodable {let jobs:[RemoteDownload]}
struct RemoteOK:Decodable {let ok:Bool}
struct DownloadOperation:Encodable {let operation:String;let id:String;var revision:String?=nil}
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
 var body:some View {TabView(selection:$playback.selectedTab) {
  Tab("Home",systemImage:"house",value:"home"){NativeHomeView(client:client,watchlist:watchlist)}
  Tab("Browse",systemImage:"square.grid.2x2",value:"browse"){RemoteLibraryView(client:client,watchlist:watchlist)}
  Tab("Watchlist",systemImage:"bookmark",value:"watchlist"){RemoteWatchlistView(client:client,model:watchlist)}
  Tab("Remote",systemImage:"play.rectangle",value:"remote"){RemoteControlView(client:client)}
  if client.scopes.contains("downloads.read") {Tab("Downloads",systemImage:"arrow.down.circle",value:"downloads"){RemoteDownloadsView(client:client)}}
 }.environment(\.playbackSession,playback).task{await watchlist.refresh(client)}}
}
struct RemoteDownloadsView:View {
 let client:RemoteClient
 @Environment(\.playbackSession) private var sharedSession
 @State private var localSession=PlaybackSession()
 @State private var jobs:[RemoteDownload]=[]
 @State private var error:String?
 @State private var loaded=false
 @State private var busy=false
 @State private var refreshGeneration=0
 @State private var pendingCancellation:RemoteDownload?
 @State private var pendingTrash:RemoteDownload?
 @State private var castJob:RemoteDownload?
 @State private var presentation:PlayerPresentation?
 @State private var playingItem:RemoteTitle?
 private var session:PlaybackSession{sharedSession ?? localSession}
 var body:some View {NavigationStack {ScrollView {LazyVStack(spacing:16){
  ForEach(jobs){job in HStack(alignment:.top,spacing:16){
   RemotePoster(item:job.displayTitle).frame(width:92,height:138).clipShape(.rect(cornerRadius:12))
   VStack(alignment:.leading,spacing:8){
    HStack(alignment:.top){Text(job.displayTitle.title).font(.headline).lineLimit(2).frame(height:44,alignment:.topLeading);Spacer(minLength:0)
     if client.scopes.contains("downloads.write"),(job.active || job.canRetry || job.canTrash==true){Menu{if job.canTrash==true{Button("Delete download…",role:.destructive){pendingTrash=job}};if job.canRetry{Button("Retry download"){mutate("retry",job:job)}};if job.active{Button("Cancel download…",role:.destructive){pendingCancellation=job}}}label:{Image(systemName:"ellipsis").frame(width:44,height:32)}.accessibilityLabel("Download actions for \(job.displayTitle.title)").disabled(busy)}
    }
    if let episode=job.episodeLabel{Text(episode).font(.subheadline).foregroundStyle(.secondary)}
    Text(job.stateLabel).font(.caption.weight(.semibold)).foregroundStyle(job.status=="error" ? .orange:.secondary)
    if job.active{ProgressView(value:job.progress,total:100).tint(FlyxTheme.accent)}
    HStack(spacing:8){if job.bytes>0{Text(ByteCountFormatter.string(fromByteCount:job.bytes,countStyle:.file))};if let total=job.totalBytes,total>job.bytes{Text("of \(ByteCountFormatter.string(fromByteCount:total,countStyle:.file))")};if let quality=job.quality,!quality.isEmpty{Text(quality)}}.font(.caption).foregroundStyle(.secondary)
    if !job.active,!job.playable,job.selection != nil{Button("Retry download"){retryVideo(job)}.font(.subheadline).disabled(busy)}
    if job.playable{Menu{Button("This iPhone",systemImage:"iphone"){play(job,to:"phone")};Button("Mac",systemImage:"desktopcomputer"){play(job,to:"mac")};Button("Cast to TV",systemImage:"tv"){castJob=job}}label:{Label("Play",systemImage:"play.fill").font(.subheadline.bold()).frame(minHeight:40).padding(.horizontal,16).foregroundStyle(FlyxTheme.ink).background(FlyxTheme.accent,in:.capsule)}.disabled(busy).accessibilityIdentifier("download.play.\(job.id)")}
    else if job.status=="done"{Text(job.selection==nil ? "Update Flyx on your Mac to show download details.":"The saved file is missing or needs relinking in Flyx on Mac.").font(.caption).foregroundStyle(.secondary)}
    if let message=job.error{Text(message).font(.caption).foregroundStyle(.orange)}
   }.frame(maxWidth:.infinity,alignment:.leading)
  }.padding(16).background(FlyxTheme.card,in:.rect(cornerRadius:20))}
  if let error{Text(error).font(.footnote).foregroundStyle(.orange);Button("Retry"){Task{await refresh()}}}
  if jobs.isEmpty{if loaded{ContentUnavailableView("No downloads",systemImage:"arrow.down.circle",description:Text("Download a title from Browse to keep a copy on your Mac."))}else{ForEach(0..<3,id:\.self){_ in HStack(spacing:16){RoundedRectangle(cornerRadius:12).fill(.quaternary).frame(width:92,height:138);VStack(alignment:.leading,spacing:12){RoundedRectangle(cornerRadius:4).fill(.quaternary).frame(height:18);RoundedRectangle(cornerRadius:4).fill(.quaternary).frame(width:100,height:12);RoundedRectangle(cornerRadius:4).fill(.quaternary).frame(width:130,height:12)};Spacer()}.padding(16).background(FlyxTheme.card,in:.rect(cornerRadius:20))}.loadingShimmer().accessibilityLabel("Loading downloads")}}
 }.padding(16)}.background(.black).navigationTitle("Downloads").refreshable{await refresh()}
 .task{while !Task.isCancelled{await refresh();do{try await Task.sleep(for:.seconds(5))}catch{return}}}
 .confirmationDialog("Delete this download?",isPresented:Binding(get:{pendingTrash != nil},set:{if !$0{pendingTrash=nil}}),titleVisibility:.visible){
  if let job=pendingTrash{Button("Move to Mac Trash",role:.destructive){mutate("trash",job:job);pendingTrash=nil}}
  Button("Keep download",role:.cancel){pendingTrash=nil}
 }message:{Text("Moves the saved file to Trash on your Mac and removes this download from the list. You can recover the file from Mac Trash.")}
 .confirmationDialog("Cancel this download?",isPresented:Binding(get:{pendingCancellation != nil},set:{if !$0{pendingCancellation=nil}}),titleVisibility:.visible){
  if let job=pendingCancellation{Button("Cancel download",role:.destructive){mutate("cancel",job:job);pendingCancellation=nil}}
  Button("Keep download",role:.cancel){pendingCancellation=nil}
 }message:{if let job=pendingCancellation{Text(job.removalClearsCache==true ? "Stops the download and keeps downloaded chapter pages for retry. Completed files are kept.":"Stops this download. Incomplete video data may be discarded; completed files are kept.")}}
 .sheet(item:$castJob){job in CastReceiverPicker(client:client){receiver in castJob=nil;play(job,to:"tv",receiverID:receiver.id)}}
 .fullScreenCover(item:$presentation){value in RemoteControlView(client:client,initialSelection:value.selection,initialItem:playingItem,startsOnPhone:value.phone,showClose:true).environment(\.playbackSession,session)}
 }}
 private func refresh()async{refreshGeneration+=1;let generation=refreshGeneration;do{let result:RemoteDownloadList=try await client.request("/remote/v1/downloads");try Task.checkCancellation();guard generation==refreshGeneration else{return};if jobs != result.jobs{jobs=result.jobs};loaded=true;error=nil}catch{if !Task.isCancelled,generation==refreshGeneration{loaded=true;self.error=error.localizedDescription}}}
 private func mutate(_ operation:String,job:RemoteDownload){guard !busy else{return};busy=true;Task{defer{busy=false};do{let _:RemoteOK=try await client.request("/remote/v1/downloads",body:JSONEncoder().encode(DownloadOperation(operation:operation,id:job.id,revision:operation=="trash" ? job.fileRevision:nil)));await refresh()}catch{await refresh();self.error=error.localizedDescription}}}
 private func retryVideo(_ job:RemoteDownload){guard !busy,let selection=job.selection else{return};busy=true;Task{defer{busy=false};do{let _:RemoteOK=try await client.download(job.displayTitle,season:selection.season,episode:selection.episode,quality:job.quality);await refresh()}catch{self.error=error.localizedDescription}}}
 private func play(_ job:RemoteDownload,to destination:String,receiverID:String?=nil){guard !busy,let selection=job.selection else{return};busy=true;error=nil;Task{defer{busy=false};do{
  let current:RemoteDownloadList=try await client.request("/remote/v1/downloads");jobs=current.jobs
  guard let fresh=current.jobs.first(where:{$0.id==job.id}),fresh.playable,fresh.selection?.id==selection.id else{throw RemoteFailure(message:"This download is no longer ready. Refresh or relink the saved file on your Mac.")}
  playingItem=fresh.displayTitle
  if destination != "phone"{let result=try await client.play(fresh.displayTitle,season:selection.season,episode:selection.episode);guard result.ok,result.status.state=="playing"else{throw RemoteFailure(message:"The Mac did not confirm playback.")};session.status=result.status;session.phoneActive=false;if destination=="tv"{try await session.switchOutput(client,to:"tv",receiverID:receiverID);if sharedSession != nil{return}}}
  presentation=PlayerPresentation(selection:selection,phone:destination=="phone")
 }catch{self.error=error.localizedDescription}}}
}

struct CastReceiverPicker:View {
 let client:RemoteClient
 let choose:(RemoteCastDevice)->Void
 @Environment(\.dismiss) private var dismiss
 @State private var receivers:[RemoteCastDevice]=[]
 @State private var loading=true
 @State private var error:String?
 @State private var refresh=0
 var body:some View{NavigationStack{List{
  if loading{ProgressView("Finding TVs…")}
  else if let error{Text(error).foregroundStyle(.orange)}
  else if receivers.isEmpty{ContentUnavailableView("No TVs found",systemImage:"tv",description:Text("Keep Flyx open and connect the Mac and TV to the same network."))}
  ForEach(receivers){receiver in Button{choose(receiver);dismiss()}label:{Label(receiver.name,systemImage:"tv")}.disabled(loading)}
  Button("Refresh receivers"){refresh+=1}.disabled(loading)
 }.navigationTitle("Cast to TV").toolbar{ToolbarItem(placement:.cancellationAction){Button("Cancel"){dismiss()}}}.task(id:refresh){
  loading=true;error=nil;receivers=[]
  do{struct Features:Decodable{let features:[String]?};let info:Features=try await client.request("/remote/v1/info");try Task.checkCancellation();guard info.features?.contains("player.transfer.confirm.v2")==true else{throw RemoteFailure(message:"Update Flyx on your Mac to enable Cast transfers.")};let value:RemoteCastResult=try await client.cast("cast.discover");try Task.checkCancellation();guard value.ok else{throw RemoteFailure(message:"TV discovery is unavailable. Keep Flyx open and retry.")};receivers=value.devices ?? [];loading=false}
  catch{if !Task.isCancelled{self.error=error.localizedDescription;loading=false}}
 }}}
}
