import Foundation
struct RemoteFailure: LocalizedError { let message:String;var status:Int?=nil;var errorDescription:String?{message} }
@main struct WatchlistSyncChecks {
 static func main()throws {
  func item(_ id:String,_ kind:String="movie")->RemoteTitle{.init(id:id,kind:kind,title:"Fixture "+id,overview:"",posterURL:nil)}
  func keys(_ s:WatchlistSyncState)->Set<String>{Set(s.current.items.map(\.stableID))}
  var checks:[String:Bool]=[:]
  let a=item("1"),b=item("2"),c=item("3"),d=item("4")
  var state=WatchlistSyncState(items:[a])
  let first=try state.bind("mac-account-a",remote:[b]);checks["firstSyncUnionsExistingLists"]=keys(state)==[a.stableID,b.stableID] && first.count==1
  state.acknowledge(first[0],target:"mac-account-a");state.receive([a,b],target:"mac-account-a")
  checks["acknowledgedQueueClears"]=state.current.pending.isEmpty
  state.receive([b],target:"mac-account-a");checks["MacRemovalDoesNotResurrect"]=keys(state)==[b.stableID]
  try state.current.edit(c,add:true);try state.current.edit(b,add:false)
  state.receive([b,d],target:"mac-account-a")
  checks["offlineAddAndRemovalSurvivePull"]=keys(state)==[c.stableID,d.stableID] && state.current.pending.count==2
  let data=try JSONEncoder().encode(state);let restored=try JSONDecoder().decode(WatchlistSyncState.self,from:data)
  checks["relaunchPreservesQueuedOperationIDs"]=restored.current.pending==state.current.pending && keys(restored)==keys(state)
  let old=state.current.pending.first{$0.item.id==c.id}!
  try state.current.edit(c,add:false);state.acknowledge(old,target:"mac-account-a")
  checks["lateAcknowledgementKeepsNewerEdit"]=state.current.pending.contains{$0.item.id==c.id && !$0.add}
  _ = try state.bind("mac-account-b",remote:[a]);checks["accountSwitchDoesNotUploadOldItems"]=keys(state)==[a.stableID] && state.current.pending.isEmpty
  let oldCount=state.replicas["mac-account-a"]!.pending.count
  _ = try state.bind("mac-account-a",remote:[d]);checks["returnRestoresAccountQueue"]=state.current.pending.count==oldCount && !keys(state).contains(a.stableID)
  state.receive([a],target:"mac-account-b");checks["staleAccountReplyIgnored"] = !keys(state).contains(a.stableID)
  try state.current.edit(item("7","movie"),add:true);try state.current.edit(item("7","tv"),add:true);try state.current.edit(item("7","anime"),add:true)
  checks["sameNumberDifferentKindsStayDistinct"]=state.current.items.filter{$0.id=="7"}.count==3
  try state.current.edit(item("7","movie"),add:true);checks["repeatedSaveIsDeduplicated"]=state.current.items.filter{$0.stableID=="movie:7"}.count==1 && state.current.pending.filter{$0.item.stableID=="movie:7"}.count==1
  let md=item("md:11111111-1111-4111-8111-111111111111","manga"),wc=item("weebcentral-1","manga")
  try state.current.edit(md,add:true);try state.current.edit(wc,add:true);checks["mangaNamespacesRemainDistinct"]=keys(state).contains(md.stableID) && keys(state).contains(wc.stableID)
  let mutation=WatchlistMutation(operation:"add",kind:a.kind,id:a.id,item:a,mutationID:UUID().uuidString,syncScope:"fixture-account")
  let encoded=try JSONSerialization.jsonObject(with:JSONEncoder().encode(mutation)) as! [String:Any]
  checks["wireMutationHasScopeAndRetryIdentity"]=encoded["syncScope"] as? String=="fixture-account" && encoded["mutationID"] != nil && encoded["item"] != nil
  checks["journalContainsNoCredentials"] = !String(decoding:data,as:UTF8.self).contains("certificatePin") && !String(decoding:data,as:UTF8.self).contains("token")
  print(String(decoding:try JSONSerialization.data(withJSONObject:checks,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
  guard checks.values.allSatisfy({$0}) else{throw RemoteFailure(message:"Watchlist reconciliation check failed")}
 }
}
