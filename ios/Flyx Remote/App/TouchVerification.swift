#if DEBUG
import SwiftUI
import ObjectiveC

/// Read-only input tracing in synthetic previews. No event injection or gesture
/// recognizer is installed, so the probe cannot win a card/header gesture.
@MainActor enum TouchVerification {
    private static var installed=false
    private static var events:[[String:Double]]=[]
    static func install(){
        guard !installed else{return};installed=true
        guard let original=class_getInstanceMethod(UIWindow.self,#selector(UIWindow.sendEvent(_:))),let replacement=class_getInstanceMethod(UIWindow.self,#selector(UIWindow.flyxTraceSendEvent(_:)))else{return}
        method_exchangeImplementations(original,replacement)
    }
    static func record(_ event:UIEvent,in window:UIWindow){
        guard event.type == .touches else{return}
        for touch in event.allTouches ?? [] {
            let point=touch.location(in:window)
            if touch.phase == .began{events=[]}
            events.append(["x":point.x,"y":point.y,"phase":Double(touch.phase.rawValue),"timestamp":touch.timestamp])
            if events.count>160{events.removeFirst()}
            if touch.phase == .ended || touch.phase == .cancelled{UIOnlyProtocol.probe(["lastTouchTrace":events])}
        }
    }
}
private extension UIWindow {
    @objc dynamic func flyxTraceSendEvent(_ event:UIEvent){TouchVerification.record(event,in:self);flyxTraceSendEvent(event)}
}
struct CategoryFrameVerification:ViewModifier {
    let kind:String
    func body(content:Content)->some View{content.onGeometryChange(for:CGRect.self){$0.frame(in:.global)}action:{frame in
        guard ProcessInfo.processInfo.arguments.contains("--flyx-ui-fixture")else{return}
        UIOnlyProtocol.probe(["categoryFrame."+kind:["x":frame.minX,"y":frame.minY,"width":frame.width,"height":frame.height]])
    }}
}
#endif
