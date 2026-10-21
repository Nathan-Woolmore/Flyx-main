import SwiftUI

/// One coalesced TimelineView for each visible placeholder group; no timers.
private struct LoadingShimmer:ViewModifier {
    var enabled:Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible=false
    private var staticMotion:Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--reduce-motion-fixture"){return true}
        #endif
        return reduceMotion
    }
    @ViewBuilder func body(content:Content)->some View {
        if !enabled || staticMotion {content}
        else {content.overlay{
            TimelineView(.animation(minimumInterval:1.0/30,paused:!visible || scenePhase != .active)){context in
                GeometryReader{geometry in
                    let phase=context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy:1.6)/1.6
                    LinearGradient(colors:[.clear,.white.opacity(0.14),.clear],startPoint:.leading,endPoint:.trailing)
                        .frame(width:geometry.size.width*0.7)
                        .offset(x:geometry.size.width*(phase*2-0.7))
                }
            }.mask{content}.allowsHitTesting(false).accessibilityHidden(true)
        }.onAppear{visible=true}.onDisappear{visible=false}}
    }
}
extension View {func loadingShimmer(_ enabled:Bool=true)->some View{modifier(LoadingShimmer(enabled:enabled))}}
