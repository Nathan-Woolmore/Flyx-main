import SwiftUI
import Observation
import UIKit
import ImageIO

struct MangaChapterRequest:Encodable{let mangaID:String;let chapterID:String}
struct MangaChapterPages:Decodable,Sendable{let handle:String;let pageCount:Int;let provider:String;let mangaID:String;let chapterID:String;let chapterNumber:Double;let language:String;let edition:String}
@MainActor @Observable final class MangaReaderModel {
    let item:RemoteTitle
    let chapters:[RemoteDetails.Chapter]
    private let store=MangaProgressStore()
    private(set) var chapterID:String
    private(set) var chapter:MangaChapterPages?
    private(set) var loading=false
    private(set) var error:String?
    var page=1
    var mode="vertical"
    var direction="rtl"
    var progressWarning:String?
    private var generation=UUID()
    init(item:RemoteTitle,chapters:[RemoteDetails.Chapter],startingChapter:String?=nil){
        self.item=item;self.chapters=chapters;chapterID=chapters.first?.id ?? ""
        let restored=store.latest(provider:"weebcentral",mangaID:item.id).first{mark in (startingChapter==nil || startingChapter==mark.chapterID) && chapters.contains{c in c.id==mark.chapterID && c.language==mark.identity.language && c.edition==mark.identity.edition}}
        chapterID=startingChapter ?? restored?.chapterID ?? chapters.first?.id ?? ""
        page=restored?.page ?? 1;mode=restored?.mode ?? "vertical";direction=restored?.direction ?? "rtl"
    }
    func load(_ id:String,client:RemoteClient)async{
        guard chapters.contains(where:{$0.id==id})else{return}
        save();let ticket=UUID();generation=ticket;chapterID=id;loading=true;error=nil;chapter=nil
        defer{if ticket==generation{loading=false}}
        do{
            let value:MangaChapterPages=try await client.request("/remote/v1/manga/chapter",body:JSONEncoder().encode(MangaChapterRequest(mangaID:item.id,chapterID:id)))
            try Task.checkCancellation();guard ticket==generation else{return}
            guard value.mangaID==item.id,value.chapterID==id,(1...1000).contains(value.pageCount) else{throw RemoteFailure(message:"The source returned a different or incomplete chapter.")}
            chapter=value
            let key=MangaEditionKey(provider:value.provider,mangaID:value.mangaID,language:value.language,edition:value.edition)
            if let saved=store.load(key),saved.chapterID==id {page=min(value.pageCount,max(1,saved.page));mode=saved.mode;direction=saved.direction}else{page=1}
            save()
        }catch is CancellationError{}catch{if ticket==generation && !Task.isCancelled{self.error=error.localizedDescription}}
    }
    func save(){
        guard let chapter,chapter.chapterID==chapterID else{return}
        let key=MangaEditionKey(provider:chapter.provider,mangaID:chapter.mangaID,language:chapter.language,edition:chapter.edition)
        do{try store.save(MangaReadingMark(identity:key,chapterID:chapter.chapterID,chapterNumber:chapter.chapterNumber,page:min(chapter.pageCount,max(1,page)),mode:mode,direction:direction,updatedAt:Date()));progressWarning=nil}
        catch{progressWarning="Progress could not be saved on this iPhone."}
    }
    func adjacent(_ delta:Int)->String?{guard let index=chapters.firstIndex(where:{$0.id==chapterID}),chapters.indices.contains(index+delta)else{return nil};return chapters[index+delta].id}
}

struct MangaReader:View {
    let client:RemoteClient
    @State private var model:MangaReaderModel
    @State private var chapterList=false
    @Environment(\.scenePhase) private var scenePhase
    init(client:RemoteClient,item:RemoteTitle,chapters:[RemoteDetails.Chapter],startingChapter:String?=nil){self.client=client;_model=State(initialValue:MangaReaderModel(item:item,chapters:chapters,startingChapter:startingChapter))}
    var body:some View {
        GeometryReader{geometry in VStack(spacing:0){
            Group{
                if model.loading {RoundedRectangle(cornerRadius:8).fill(.quaternary).loadingShimmer().overlay{ProgressView("Loading chapter…")}}
                else if let chapter=model.chapter {
                    if model.mode=="paged" {
                        MangaPageView(client:client,handle:chapter.handle,page:model.page,reload:reload,turn:{left in
                            let delta=(left == (model.direction=="ltr")) ? 1:-1
                            model.page=min(chapter.pageCount,max(1,model.page+delta))
                        }).id(chapter.handle+"|"+String(model.page))
                    }else{
                        ScrollView {LazyVStack(spacing:8){ForEach(1...chapter.pageCount,id:\.self){page in MangaPageView(client:client,handle:chapter.handle,page:page,reload:reload).frame(height:max(200,geometry.size.height-70)).id(page)}}.scrollTargetLayout()}
                            .scrollPosition(id:Binding<Int?>(get:{model.page},set:{if let value=$0{model.page=value}}))
                    }
                }else{ContentUnavailableView("Chapter unavailable",systemImage:"book.closed",description:Text(model.error ?? "Choose a chapter."))}
            }.frame(maxWidth:.infinity,maxHeight:.infinity)
            HStack{
                Button{move(-1)}label:{Image(systemName:"chevron.backward").frame(width:44,height:44)}.disabled(model.adjacent(-1)==nil||model.loading).accessibilityLabel("Previous chapter")
                Spacer()
                VStack(spacing:3){
                    if let chapter=model.chapter {
                        Menu {
                            Picker("Page",selection:$model.page){ForEach(1...chapter.pageCount,id:\.self){page in Text("Page \(page)").tag(page)}}
                        }label:{Text("Page \(model.page) / \(chapter.pageCount)").font(.subheadline.monospacedDigit())}
                        .accessibilityLabel("Choose page, \(model.page) of \(chapter.pageCount)")
                    }else{Text(model.loading ? "Loading chapter…":"Chapter unavailable").font(.subheadline)}
                    Text(model.progressWarning ?? (model.chapter == nil ? "":"Spot saved on this iPhone")).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button{move(1)}label:{Image(systemName:"chevron.forward").frame(width:44,height:44)}.disabled(model.adjacent(1)==nil||model.loading).accessibilityLabel("Next chapter")
            }.padding(.horizontal)
            if let error=model.error {Text(error).font(.caption).foregroundStyle(.orange);Button("Retry chapter"){reload()}}
        }}.navigationTitle(model.item.title).navigationBarTitleDisplayMode(.inline)
        .toolbar{
            ToolbarItem(placement:.topBarTrailing){Button{chapterList=true}label:{Image(systemName:"list.bullet")}.accessibilityLabel("Chapters")}
            ToolbarItem(placement:.topBarTrailing){Menu{Picker("Reading mode",selection:$model.mode){Text("Vertical").tag("vertical");Text("Paged").tag("paged")};Picker("Reading direction",selection:$model.direction){Text("Right to left").tag("rtl");Text("Left to right").tag("ltr")};Text("Progress stays on this iPhone; editions remain separate.")}label:{Image(systemName:"textformat.size")}.accessibilityLabel("Reader settings")}
        }.sheet(isPresented:$chapterList){NavigationStack{List(model.chapters){chapter in Button{chapterList=false;Task{await model.load(chapter.id,client:client)}}label:{HStack{VStack(alignment:.leading){Text(chapter.title);Text("Chapter \(chapter.number.formatted()) · \(chapter.language) · \(chapter.edition.hasPrefix("unlabeled:") ? "Unlabeled edition":chapter.edition)").font(.caption).foregroundStyle(.secondary)};if chapter.id==model.chapterID{Image(systemName:"checkmark")}}}}.navigationTitle("Chapters").toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){chapterList=false}}}}}
        .task{await model.load(model.chapterID,client:client)}.onChange(of:model.page){_,_ in model.save()}.onChange(of:model.mode){_,_ in model.save()}.onChange(of:model.direction){_,_ in model.save()}.onChange(of:scenePhase){_,phase in if phase != .active{model.save()}}.onDisappear{model.save()}
    }
    private func reload(){Task{await model.load(model.chapterID,client:client)}}
    private func move(_ delta:Int){if let id=model.adjacent(delta){Task{await model.load(id,client:client)}}}
}

private struct MangaPageView:View {
    let client:RemoteClient;let handle:String;let page:Int;let reload:()->Void
    var turn:((Bool)->Void)? = nil
    @State private var image:UIImage?
    @State private var error:String?
    @State private var zoomed=false
    var body:some View {ZStack{
        if let image{ZoomableMangaPage(image:image,zoomChanged:{zoomed=$0}).accessibilityLabel("Page \(page)")}
        else if let error{VStack{Text(error).font(.footnote);Button("Retry chapter",action:reload)}.padding()}
        else{RoundedRectangle(cornerRadius:8).fill(.quaternary).loadingShimmer().overlay{ProgressView("Page \(page)")}}
    }.simultaneousGesture(DragGesture(minimumDistance:40).onEnded{value in
        guard !zoomed,abs(value.translation.width)>60,abs(value.translation.width)>abs(value.translation.height)*1.2 else{return}
        turn?(value.translation.width<0)
    }).task(id:handle+"|"+String(page)){
        image=nil;error=nil
        do{
            let data=try await client.bytes("/remote/v1/manga/image",query:[.init(name:"handle",value:handle),.init(name:"page",value:String(page))])
            try Task.checkCancellation()
            guard data.count<=8_388_608,let source=CGImageSourceCreateWithData(data as CFData,nil),let cg=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:4096,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary) else{throw RemoteFailure(message:"This page image is unsupported. Retry the chapter.")}
            image=UIImage(cgImage:cg)
        }catch is CancellationError{}catch{if !Task.isCancelled{self.error=error.localizedDescription}}
    }}
}

/// UIKit zoom/pan is used because SwiftUI's image magnification does not provide
/// a bounded native zoom viewport. The view keeps the same dimensions while loading.
@MainActor private struct ZoomableMangaPage:UIViewRepresentable {
    let image:UIImage
    let zoomChanged:(Bool)->Void
    func makeCoordinator()->Coordinator{Coordinator(zoomChanged:zoomChanged)}
    func makeUIView(context:Context)->UIScrollView{
        let scroll=PageScroll();scroll.delegate=context.coordinator;scroll.minimumZoomScale=1;scroll.maximumZoomScale=4;scroll.showsVerticalScrollIndicator=false;scroll.showsHorizontalScrollIndicator=false
        let view=context.coordinator.imageView;view.contentMode = .scaleAspectFit;scroll.addSubview(view);scroll.pageImage=view;scroll.panGestureRecognizer.isEnabled=false
        let doubleTap=UITapGestureRecognizer(target:context.coordinator,action:#selector(Coordinator.doubleTap(_:)));doubleTap.numberOfTapsRequired=2;scroll.addGestureRecognizer(doubleTap)
        return scroll
    }
    func updateUIView(_ scroll:UIScrollView,context:Context){context.coordinator.zoomChanged=zoomChanged;let view=context.coordinator.imageView;if view.image !== image{scroll.setZoomScale(1,animated:false);view.image=image};if scroll.zoomScale==1{view.frame=scroll.bounds;scroll.contentSize=scroll.bounds.size}}
    final class PageScroll:UIScrollView {weak var pageImage:UIImageView?;override func layoutSubviews(){super.layoutSubviews();if zoomScale==1{pageImage?.frame=CGRect(origin:.zero,size:bounds.size);contentSize=bounds.size}}}
    final class Coordinator:NSObject,UIScrollViewDelegate {
        let imageView=UIImageView()
        var zoomChanged:(Bool)->Void
        init(zoomChanged:@escaping (Bool)->Void){self.zoomChanged=zoomChanged}
        func viewForZooming(in scrollView:UIScrollView)->UIView?{imageView}
        func scrollViewDidZoom(_ scrollView:UIScrollView){scrollView.panGestureRecognizer.isEnabled=scrollView.zoomScale>1;zoomChanged(scrollView.zoomScale>1)}
        @objc func doubleTap(_ recognizer:UITapGestureRecognizer){guard let scroll=recognizer.view as? UIScrollView else{return};scroll.setZoomScale(scroll.zoomScale>1 ? 1:2,animated:!UIAccessibility.isReduceMotionEnabled)}
    }
}
