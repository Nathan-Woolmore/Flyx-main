import SwiftUI
import UIKit

/// A non-key overlay window keeps the same dismissal affordance above sheets and native search.
struct KeyboardDismissButton: ViewModifier {
    @State private var keyboardFrame:CGRect?
    func body(content:Content)->some View {
        content.background(KeyboardOverlayHost(keyboardFrame:keyboardFrame).frame(width:0,height:0))
            .onReceive(NotificationCenter.default.publisher(for:UIResponder.keyboardWillShowNotification)){note in keyboardFrame=note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect}
            .onReceive(NotificationCenter.default.publisher(for:UIResponder.keyboardWillChangeFrameNotification)){note in keyboardFrame=note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect}
            .onReceive(NotificationCenter.default.publisher(for:UIResponder.keyboardWillHideNotification)){_ in keyboardFrame=nil}
    }
}
extension View {func keyboardDismissButton()->some View {modifier(KeyboardDismissButton())}}
@MainActor private struct KeyboardOverlayHost:UIViewRepresentable {
    let keyboardFrame:CGRect?
    func makeUIView(context:Context)->Anchor {let view=Anchor();view.owner=context.coordinator;return view}
    func updateUIView(_ view:Anchor,context:Context){context.coordinator.update(scene:view.window?.windowScene,keyboardFrame:keyboardFrame)}
    func makeCoordinator()->Coordinator {Coordinator()}
    static func dismantleUIView(_ view:Anchor,coordinator:Coordinator){coordinator.hide()}
    final class Anchor:UIView {
        weak var owner:Coordinator?
        override func didMoveToWindow(){super.didMoveToWindow();owner?.attach(scene:window?.windowScene)}
    }
    final class TouchThroughWindow:UIWindow {
        weak var dismissalButton:UIButton?
        override func hitTest(_ point:CGPoint,with event:UIEvent?)->UIView? {
            guard dismissalButton?.frame.contains(point)==true else{return nil}
            return super.hitTest(point,with:event)
        }
    }
    @MainActor final class Coordinator:NSObject {
        private var overlay:TouchThroughWindow?
        private var keyboardFrame:CGRect?
        private let button=UIButton(type:.system)
        func attach(scene:UIWindowScene?){
            guard let scene,overlay?.windowScene !== scene else{return}
            let window=TouchThroughWindow(windowScene:scene);window.windowLevel = .normal+1;window.backgroundColor = .clear;window.overrideUserInterfaceStyle = .dark
            let controller=UIViewController();controller.view.backgroundColor = .clear;window.rootViewController=controller
            var config=UIButton.Configuration.filled();config.image=UIImage(systemName:"keyboard.chevron.compact.down");config.baseBackgroundColor = .secondarySystemBackground;config.baseForegroundColor = .label;config.cornerStyle = .capsule
            button.configuration=config;button.accessibilityLabel="Hide keyboard";button.accessibilityHint="Dismiss the keyboard and keep your text";button.addTarget(self,action:#selector(dismissKeyboard),for:.touchUpInside)
            controller.view.addSubview(button);window.dismissalButton=button;overlay=window;layout()
        }
        func update(scene:UIWindowScene?,keyboardFrame:CGRect?){self.keyboardFrame=keyboardFrame;attach(scene:scene);layout()}
        private func layout(){
            guard let overlay,let keyboardFrame else{overlay?.isHidden=true;return}
            let local=overlay.convert(keyboardFrame,from:nil),safe=overlay.safeAreaInsets
            guard let frame=KeyboardButtonGeometry.frame(bounds:overlay.bounds,keyboard:local,top:safe.top,right:safe.right,bottom:safe.bottom) else{overlay.isHidden=true;return}
            button.frame=frame;overlay.isHidden=false // Never make this window key: typing stays in the original input.
        }
        @objc private func dismissKeyboard(){UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),to:nil,from:nil,for:nil)}
        func hide(){overlay?.isHidden=true;overlay=nil}
    }
}
