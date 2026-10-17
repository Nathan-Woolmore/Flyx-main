import Foundation
import CoreGraphics
struct KeyboardButtonGeometry {
    static func frame(bounds:CGRect, keyboard:CGRect, top:CGFloat=0, right:CGFloat=0, bottom:CGFloat=0)->CGRect? {
        guard keyboard.height>0,keyboard.minY<bounds.maxY,keyboard.maxY>bounds.minY else{return nil}
        let size:CGFloat=48
        return CGRect(x:max(bounds.minX,bounds.maxX-right-16-size),y:max(bounds.minY+top+8,min(bounds.maxY-bottom-8-size,keyboard.minY-8-size)),width:size,height:size)
    }
}
