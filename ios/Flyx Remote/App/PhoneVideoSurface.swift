import SwiftUI
@preconcurrency import AVFoundation

/// Video rendering only. All controls belong to the shared Flyx surface, so
/// AVKit cannot place a second volume/fullscreen layer over its buttons.
struct PhoneVideoSurface:UIViewRepresentable {
    let player:AVPlayer
    final class Surface:UIView {
        override class var layerClass:AnyClass{AVPlayerLayer.self}
        var videoLayer:AVPlayerLayer{layer as! AVPlayerLayer}
    }
    func makeUIView(context:Context)->Surface{let view=Surface();view.backgroundColor = .black;view.videoLayer.videoGravity = .resizeAspect;view.videoLayer.player=player;return view}
    func updateUIView(_ view:Surface,context:Context){view.videoLayer.player=player}
    static func dismantleUIView(_ view:Surface,coordinator:()){view.videoLayer.player=nil}
}
