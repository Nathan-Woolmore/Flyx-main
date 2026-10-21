import SwiftUI
// Final Flyx brand overrides in the Mac app's globals.css, not the legacy palette.
enum FlyxTheme {
    static let accent=Color(red:200/255,green:1,blue:61/255)
    static let background=Color(red:8/255,green:9/255,blue:11/255)
    static let card=Color(red:18/255,green:20/255,blue:24/255)
    static let ink=Color(red:8/255,green:9/255,blue:11/255)
}
struct CatalogueGlassHeader:View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private var opaque:Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("header-reduced"){return true}
        #endif
        return reduceTransparency
    }
    var body:some View {
        Color.black.ignoresSafeArea(.container,edges:.top)
            .overlay(alignment:.bottom){
                if !opaque {
                    LinearGradient(stops:[.init(color:.black,location:0),.init(color:.black.opacity(0.97),location:0.12),.init(color:.black.opacity(0.84),location:0.28),.init(color:.black.opacity(0.56),location:0.48),.init(color:.black.opacity(0.25),location:0.68),.init(color:.black.opacity(0.06),location:0.86),.init(color:.clear,location:1)],startPoint:.top,endPoint:.bottom)
                        .frame(height:44).offset(y:44)
                }
            }.allowsHitTesting(false)
    }
}
