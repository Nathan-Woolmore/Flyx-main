#if DEBUG
import SwiftUI
@preconcurrency import AVKit

/// Explicit public sample proof. This is never used as a provider fallback.
@MainActor struct StandalonePlaybackCheckpoint:View {
    let client:RemoteClient
    @State private var playback:PlaybackSession
    init(client:RemoteClient){self.client=client;let session=PlaybackSession();session.phone.player.isMuted=true;session.phone.player.volume=0;_playback=State(initialValue:session)}
    private var anime:Bool{ProcessInfo.processInfo.arguments.contains("--standalone-anime57")}
    private var television:Bool{ProcessInfo.processInfo.arguments.contains("--standalone-tv56")}
    private var movie:Bool{ProcessInfo.processInfo.arguments.contains("--standalone-movie54")}
    var body:some View {RemoteControlView(client:client,initialSelection:PhonePlaybackSelection(kind:anime ? "anime":(television ? "tv":"movie"),contentID:anime ? 1:(television ? 1396:(movie ? 27205:900000099)),season:(anime || television) ? 1:nil,episode:(anime || television) ? 1:nil),initialItem:RemoteTitle(id:"900000099",kind:"movie",title:anime ? "Cowboy Bebop · Episode 1":television ? "Breaking Bad · S1 E1":(movie ? "Inception":"Apple HLS playback check"),overview:"Independent public test stream",posterURL:nil),startsOnPhone:true).environment(\.playbackSession,playback).task{await verify()}}
    private func verify()async {
        var proof:[String:Any]=["sample":anime ? "Cowboy Bebop · Episode 1 · independent 2embed source":television ? "Breaking Bad · S1 E1 · 2embed default provider":(movie ? "Inception · 2embed default provider":"Apple public HLS test stream"),"providerMovieVerified":false,"providerAnimeVerified":false]
        func record(){let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0];try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);if let data=try? JSONSerialization.data(withJSONObject:proof,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:root.appendingPathComponent(anime ? "standalone-anime57.json":television ? "standalone-tv56.json":(movie ? "standalone-movie54.json":"standalone-checkpoint53.json")),options:.atomic)}}
        if television{let policy=await StandaloneService().debugFallbackChecks();proof["fallbackPolicy"]=(try? JSONSerialization.jsonObject(with:policy)) ?? [:]}
        for _ in 0..<150 {if playback.phone.ready,playback.phone.player.currentTime().seconds>2{break};if !playback.phone.busy,playback.phone.error != nil{break};try? await Task.sleep(for:.milliseconds(500));if Task.isCancelled{return}}
        let player=playback.phone.player
        proof["ready"]=playback.phone.ready;proof["muted"]=player.isMuted && player.volume==0
        proof["duration"]=player.currentItem?.duration.seconds.isFinite==true ? player.currentItem!.duration.seconds:0
        let first=player.currentTime().seconds;proof["positionBefore"]=first.isFinite ? first:0
        proof["error"]=playback.phone.error ?? ""
        guard playback.phone.ready,first.isFinite,first>2 else{record();return}
        player.pause();let paused=player.currentTime().seconds;try? await Task.sleep(for:.milliseconds(600));proof["pauseHeld"]=abs(player.currentTime().seconds-paused)<0.3
        let target=min(20,max(5,(player.currentItem?.duration.seconds ?? 30)/4))
        let sought=await player.seek(to:CMTime(seconds:target,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero);proof["seekSucceeded"]=sought && abs(player.currentTime().seconds-target)<1
        player.play();try? await Task.sleep(for:.seconds(2));let after=player.currentTime().seconds;proof["resumeAdvanced"]=after>target+0.5;proof["positionAfter"]=after.isFinite ? after:0
        let size=player.currentItem?.presentationSize ?? .zero;proof["width"]=size.width;proof["height"]=size.height
        await playback.phone.flushProgress(client)
        let saved:ProgressReply?=try? await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"read",selection:PhonePlaybackSelection(kind:anime ? "anime":(television ? "tv":"movie"),contentID:anime ? 1:(television ? 1396:(movie ? 27205:900000099)),season:(anime || television) ? 1:nil,episode:(anime || television) ? 1:nil))))
        proof["localProgressSaved"]=(saved?.entry?.position ?? 0)>target
        if television{proof["progressEpisodeMatches"]=saved?.entry?.kind=="tv" && saved?.entry?.contentID==1396 && saved?.entry?.season==1 && saved?.entry?.episode==1}
        proof["providerAnimeVerified"]=anime && (proof["resumeAdvanced"] as? Bool==true) && (proof["seekSucceeded"] as? Bool==true) && size.width>0
        proof["currentSource"]=playback.phone.currentSource ?? "";proof["sourceCount"]=playback.phone.sources.count
        proof["providerTVVerified"]=television && (proof["resumeAdvanced"] as? Bool==true) && (proof["seekSucceeded"] as? Bool==true) && size.width>0
        proof["providerMovieVerified"]=movie && (proof["resumeAdvanced"] as? Bool==true) && (proof["seekSucceeded"] as? Bool==true)
        record()
    }
}
#endif

#if DEBUG
/// Uses live catalogue/details and the production native player; no synthetic title or media URL.
@MainActor struct StandaloneCataloguePlaybackCheckpoint:View {
    let client:RemoteClient
    @State private var item:RemoteTitle?
    @State private var playback=PlaybackSession()
    @State private var message="Searching the live anime catalogue…"
    var body:some View{Group{if let item,let id=Int(item.id){RemoteControlView(client:client,initialSelection:.init(kind:item.kind,contentID:id,season:1,episode:2),initialItem:item,startsOnPhone:true).environment(\.playbackSession,playback)}else{Text(message)}}.task{await verify()}}
    private func verify()async {
        var proof:[String:Any]=["route":"live catalogue → details → RemoteControlView → PhonePlaybackModel → AVPlayer","manualTapThrough":false,"muted":true]
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        func record(){try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);if let data=try? JSONSerialization.data(withJSONObject:proof,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("standalone-catalogue58.json"),options:.atomic)}}
        playback.phone.player.isMuted=true;playback.phone.player.volume=0
        do {
            let query=ProcessInfo.processInfo.arguments.contains("--catalogue-cowboy") ? "Cowboy Bebop":"Samurai Champloo"
            let results=try await client.catalog(kind:"anime",query:query)
            guard let found=results.items.first(where:{$0.title==query}),let id=Int(found.id) else{throw RemoteFailure(message:"The requested animated series is absent from the live catalogue.")}
            let details=try await client.details(found)
            guard details.playbackUnavailable==nil,(details.episodeCount ?? 0)>=2 else{throw RemoteFailure(message:details.playbackUnavailable ?? "Episode 2 is unavailable.")}
            proof["catalogueTitle"]=found.title;proof["catalogueID"]=found.id;proof["detailsIDMatches"]=details.id==found.id;proof["episodeCount"]=details.episodeCount ?? 0
            if let mapping=await StandaloneService.shared.animeMappings[id]{proof["mappedMAL"]=mapping.malID;proof["providerEdition"]=mapping.providerID;proof["mappedEpisode"]=2}
            item=found
            for _ in 0..<150{if playback.phone.ready,playback.phone.player.currentTime().seconds>2{break};try await Task.sleep(for:.milliseconds(500))}
            guard playback.phone.ready,let current=playback.phone.player.currentItem else{throw RemoteFailure(message:playback.phone.error ?? "Native playback did not become ready within the bounded wait.")}
            let player=playback.phone.player,before=player.currentTime().seconds
            try await Task.sleep(for:.seconds(2));let after=player.currentTime().seconds
            let text=try await current.asset.loadMediaSelectionGroup(for:.legible),audio=try await current.asset.loadMediaSelectionGroup(for:.audible)
            proof["nativeSubtitleOptions"]=text?.options.map{$0.displayName} ?? [];proof["nativeAudioOptions"]=audio?.options.map{$0.displayName} ?? []
            proof["providerTrackFields"]=await StandaloneService.shared.debugProviderTrackFields
            proof["providerIdentity"]=await StandaloneService.shared.debugProviderIdentity
            proof["ready"]=true;proof["positionBefore"]=before;proof["positionAfter"]=after;proof["advancing"]=after>before+0.5;proof["duration"]=current.duration.seconds;proof["width"]=current.presentationSize.width;proof["height"]=current.presentationSize.height
            await playback.phone.flushProgress(client)
            let saved:ProgressReply=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"read",selection:.init(kind:"anime",contentID:id,season:1,episode:2))))
            proof["progressEpisodeMatches"]=saved.entry?.kind=="anime" && saved.entry?.contentID==id && saved.entry?.season==1 && saved.entry?.episode==2
            proof["localProgressSaved"]=(saved.entry?.position ?? 0)>2
            proof["mangaRefusal"]=try await StandaloneService().debugMangaRefusal58()
            player.pause();record()
        }catch{proof["error"]=error.localizedDescription;message=error.localizedDescription;record()}
    }
}
extension StandaloneService {
    func debugMangaRefusal58()async throws->String{
        let host="refused-manga.invalid",handle="inert-refusal-check"
        refusedHosts.insert(host)
        mangaAccess[handle] = .init(mangaID:"md:inert",chapterID:"md:inert",number:1,language:"en",edition:"inert",pages:[URL(string:"https://refused-manga.invalid/data-saver/hash/page.jpg")!],expires:Date().addingTimeInterval(60))
        do{_ = try await mangaImage(["handle":handle,"page":"1"]);return "Unexpected success"}catch let failure as RemoteFailure{return "\(failure.message) · network requests: \(debugNetworkRequests)"}
    }
}
#endif

#if DEBUG
@MainActor struct StandaloneSpotCheckpoint59:View {
    let client:RemoteClient
    @State private var item:RemoteTitle?
    @State private var playback=PlaybackSession()
    @State private var message="Checking standalone playback…"
    private var sample:String{ProcessInfo.processInfo.arguments.contains("--spot-anime59") ? "anime":(ProcessInfo.processInfo.arguments.contains("--spot-tv59") ? "tv":"movie")}
    private var selection:PhonePlaybackSelection{.init(kind:sample,contentID:sample=="anime" ? Int(item?.id ?? "") ?? 1535:(sample=="tv" ? 1396:120467),season:sample=="movie" ? nil:1,episode:sample=="movie" ? nil:(sample=="anime" ? 3:2))}
    var body:some View{Group{if let item{RemoteControlView(client:client,initialSelection:selection,initialItem:item,startsOnPhone:true).environment(\.playbackSession,playback)}else{Text(message)}}.task{await verify()}}
    private func verify()async{
        var proof:[String:Any]=["sample":sample,"manualTapThrough":false,"route":"production RemoteClient → standalone service → RemoteControlView → native AVPlayer"]
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        func record(){try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);if let data=try? JSONSerialization.data(withJSONObject:proof,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("standalone-spot59.json"),options:.atomic)}}
        playback.phone.player.isMuted=true;playback.phone.player.volume=0
        do{
            // Offline compatibility checks use the production URL builder, never a chapter-image request.
            let base=URL(string:"https://images.invalid/root")!,plain=try StandaloneService.mangaPageURL(base:base,hash:"abc123",filename:"page.jpg"),trailing=try StandaloneService.mangaPageURL(base:URL(string:"https://images.invalid/root/")!,hash:"abc123",filename:"page.jpg"),reserved=try StandaloneService.mangaPageURL(base:base,hash:"abc123",filename:"page #1?.jpg")
            proof["mangaURLConstruction"]=["trailingSlashEquivalent":plain==trailing,"reservedFilenameEncoded":reserved.query==nil && reserved.fragment==nil && reserved.lastPathComponent=="page #1?.jpg"]
            proof["mangaRefusal"]=try await StandaloneService().debugMangaRefusal58()
            let policy=await StandaloneService().debugFallbackChecks();proof["fallbackPolicy"]=(try? JSONSerialization.jsonObject(with:policy)) ?? [:]
            if sample=="anime"{
                let page=try await client.catalog(kind:"anime",query:"Death Note")
                guard let found=page.items.first(where:{$0.title=="Death Note"}) else{throw RemoteFailure(message:"Death Note is absent from the live anime catalogue.")}
                let details=try await client.details(found);guard details.playbackUnavailable==nil else{throw RemoteFailure(message:details.playbackUnavailable!)}
                proof["catalogueID"]=found.id;proof["detailsIDMatches"]=details.id==found.id;proof["episodeCount"]=details.episodeCount ?? 0
                if let id=Int(found.id),let mapping=await StandaloneService.shared.animeMappings[id]{proof["mappedMAL"]=mapping.malID;proof["providerEdition"]=mapping.providerID;proof["mappedEpisode"]=3}
                item=found
            }else{item=RemoteTitle(id:sample=="tv" ? "1396":"120467",kind:sample,title:sample=="tv" ? "Breaking Bad · S1 E2":"The Grand Budapest Hotel",overview:"",posterURL:nil)}
            proof["title"]=item?.title;proof["selection"]=["kind":selection.kind,"contentID":selection.contentID,"season":selection.season ?? 1,"episode":selection.episode ?? 1]
            for _ in 0..<150{if playback.phone.ready,playback.phone.player.currentTime().seconds>2{break};if !playback.phone.busy,playback.phone.error != nil{break};try await Task.sleep(for:.milliseconds(500))}
            let player=playback.phone.player
            guard playback.phone.ready,let current=player.currentItem else{throw RemoteFailure(message:playback.phone.error ?? "Native playback did not become ready within the bounded wait.")}
            proof["providerIdentity"]=await StandaloneService.shared.debugProviderIdentity;proof["resolvedTitle"]=playback.phone.title
            proof["muted"]=player.isMuted && player.volume==0;proof["ready"]=true;proof["duration"]=current.duration.seconds
            let first=player.currentTime().seconds;try await Task.sleep(for:.seconds(2));proof["positionBefore"]=first;proof["positionAfter"]=player.currentTime().seconds;proof["advancing"]=player.currentTime().seconds>first+0.5
            player.pause();let held=player.currentTime().seconds;try await Task.sleep(for:.milliseconds(400));proof["pauseHeld"]=abs(player.currentTime().seconds-held)<0.3
            let sought=await player.seek(to:CMTime(seconds:35,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero);proof["seekSucceeded"]=sought && abs(player.currentTime().seconds-35)<1
            player.play();try await Task.sleep(for:.seconds(2));proof["resumeAdvanced"]=player.currentTime().seconds>35.5
            let size=current.presentationSize;proof["width"]=size.width;proof["height"]=size.height
            proof["qualityOptions"]=playback.phone.sources.map(\.quality);proof["selectedQuality"]=playback.phone.sourceInfo?.quality ?? "Unknown";proof["autoQualityUncapped"]=current.preferredPeakBitRate==0 && current.preferredMaximumResolution == .zero
            proof["sourceCount"]=playback.phone.sources.count;proof["selectedSource"]=playback.phone.currentSource ?? "";proof["inertFailureBeforeLiveSource"]=ProcessInfo.processInfo.arguments.contains("--standalone-fallback56")
            let group=try await current.asset.loadMediaSelectionGroup(for:.legible);proof["subtitleOptions"]=group?.options.map(\.displayName) ?? []
            await playback.phone.flushProgress(client)
            let saved:ProgressReply=try await client.request("/remote/v1/progress",body:JSONEncoder().encode(ProgressOperation(operation:"read",selection:selection)))
            proof["progressIdentityMatches"]=saved.entry?.kind==selection.kind && saved.entry?.contentID==selection.contentID && (sample=="movie" || (saved.entry?.season==selection.season && saved.entry?.episode==selection.episode))
            proof["savedPosition"]=saved.entry?.position ?? 0
            player.pause();record()
        }catch{proof["error"]=error.localizedDescription;message=error.localizedDescription;record()}
    }
}
#endif

#if DEBUG
@MainActor struct StandaloneQualityCheckpoint60:View{
    let client:RemoteClient
    @State private var playback=PlaybackSession()
    private var sample:Bool{ProcessInfo.processInfo.arguments.contains("--quality-public60")}
    var body:some View{RemoteControlView(client:client,initialSelection:.init(kind:"movie",contentID:sample ? 900000099:120467,season:nil,episode:nil),initialItem:RemoteTitle(id:sample ? "900000099":"120467",kind:"movie",title:sample ? "Apple public HLS quality sample":"The Grand Budapest Hotel",overview:"",posterURL:nil),startsOnPhone:true).environment(\.playbackSession,playback).task{await verify()}}
    private func verify()async{
        var proof:[String:Any]=["sample":sample ? "Apple public HLS sample · explicitly labelled":"The Grand Budapest Hotel · real default provider","manualTapThrough":false]
        let directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        func record(){try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);if let data=try? JSONSerialization.data(withJSONObject:proof,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:directory.appendingPathComponent("standalone-quality60.json"),options:.atomic)}}
        playback.phone.player.isMuted=true;playback.phone.player.volume=0
        do{
            for _ in 0..<150{if playback.phone.ready,playback.phone.player.currentTime().seconds>2{break};if !playback.phone.busy,playback.phone.error != nil{break};try await Task.sleep(for:.milliseconds(500))}
            let phone=playback.phone,player=phone.player
            guard phone.ready,let original=player.currentItem else{throw RemoteFailure(message:phone.error ?? "Native quality test timed out.")}
            proof["ready"]=true;proof["initialPreference"]=phone.qualityPreference
            proof["advertisedVariants"]=phone.qualityChoices.map{["width":$0.width,"height":$0.height,"bitRate":$0.bitRate] as [String:Any]}
            proof["selectedSource"]=phone.currentSource ?? "";proof["sourceCount"]=phone.sources.count
            phone.selectQuality("highest");proof["highestSelected"]=phone.effectiveQualityID=="highest"
            let selectedBeforeInvalid=phone.qualityPreference;phone.selectQuality("r:9999x9999");proof["invalidChoiceRejected"]=phone.qualityPreference==selectedBeforeInvalid
            player.pause();let position=player.currentTime().seconds
            if let low=phone.qualityChoices.last{
                phone.selectQuality(low.id);proof["manualPreferenceApplied"]=original.preferredMaximumResolution==low.size && phone.effectiveQualityID==low.id
                proof["manualTarget"]=low.label;proof["pausedAfterQualityChange"]=player.rate==0 && abs(player.currentTime().seconds-position)<0.3
                proof["samePlayerItem"]=player.currentItem===original
                player.play();_ = await player.seek(to:CMTime(seconds:35,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero)
                for _ in 0..<30{if original.presentationSize.height<=CGFloat(low.height)+1,player.currentTime().seconds>36{break};try await Task.sleep(for:.milliseconds(400))}
                proof["manualDecodedWidth"]=original.presentationSize.width;proof["manualDecodedHeight"]=original.presentationSize.height;proof["manualNativePlaybackContinues"]=player.currentTime().seconds>36 && original.presentationSize.width>0
            }
            phone.selectQuality("automatic");proof["automaticUncapped"]=original.preferredMaximumResolution == .zero && original.preferredPeakBitRate==0
            phone.selectQuality("highest");proof["highestPreferencePersists"]=PhonePlaybackModel().qualityPreference=="highest"
            proof["highestHasNoBitrateCap"]=original.preferredPeakBitRate==0;proof["sameItemAfterAllChanges"]=player.currentItem===original
            let before=player.currentTime().seconds;try await Task.sleep(for:.seconds(2));proof["advancingAfterChanges"]=player.currentTime().seconds>before+0.5
            proof["decodedWidth"]=original.presentationSize.width;proof["decodedHeight"]=original.presentationSize.height;proof["qualitySummary"]=phone.qualitySummary;proof["muted"]=player.isMuted && player.volume==0
            await phone.flushProgress(client);player.pause();record()
        }catch{proof["error"]=error.localizedDescription;record()}
    }
}
#endif
