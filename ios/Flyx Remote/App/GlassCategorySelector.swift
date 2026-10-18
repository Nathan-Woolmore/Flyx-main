import SwiftUI

struct GlassCategorySelector:View {
    let selected:String
    let select:(String)->Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let options=[("movie","Movies"),("tv","TV"),("anime","Anime"),("manga","Manga")]
    private var opaque:Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("header-reduced"){return true}
        #endif
        return reduceTransparency
    }
    var body:some View {
        if #available(iOS 26,*),!opaque{GlassEffectContainer(spacing:4){row}}else{row}
    }
    private var row:some View {
        HStack(spacing:4){ForEach(options,id:\.0){kind,title in
            Button{select(kind)}label:{Text(title).font(.subheadline.weight(.semibold))
                .frame(maxWidth:.infinity,minHeight:44).contentShape(Rectangle())
                .foregroundStyle(selected==kind ? FlyxTheme.ink:Color.primary)}
                .buttonStyle(.plain).modifier(CategoryGlass(selected:selected==kind,opaque:opaque))
                #if DEBUG
                .modifier(CategoryFrameVerification(kind:kind))
                #endif
                .accessibilityIdentifier("category."+kind).accessibilityAddTraits(selected==kind ? .isSelected:[])
        }}
    }
}
private struct CategoryGlass:ViewModifier {
    let selected:Bool
    let opaque:Bool
    @ViewBuilder func body(content:Content)->some View {
        if #available(iOS 26,*),!opaque{
            content.glassEffect(selected ? .regular.tint(FlyxTheme.accent.opacity(0.9)).interactive():.clear.interactive(),in:.capsule)
        }else{content.background(selected ? FlyxTheme.accent:FlyxTheme.card,in:.capsule)}
    }
}

/// The symbol and score are one intrinsic-width unit in every card layout.
struct RatingValue:View {
    let rating:Double
    var body:some View {
        HStack(spacing:4){
            Image(systemName:"star.fill").accessibilityHidden(true)
            Text(rating.formatted(.number.precision(.fractionLength(1)))).monospacedDigit().lineLimit(1)
        }.fixedSize(horizontal:true,vertical:true)
            .accessibilityElement(children:.ignore)
            .accessibilityLabel("Rating \(rating.formatted(.number.precision(.fractionLength(1)))) out of 10")
    }
}

struct PosterRating:View {
    let rating:Double?
    var body:some View {
        if let rating,rating>0 {
            RatingValue(rating:rating)
                .font(.caption.weight(.semibold)).foregroundStyle(.white)
                .padding(.horizontal,9).padding(.vertical,5).fixedSize(horizontal:true,vertical:true)
                .background(.black.opacity(0.65),in:.capsule)
                .overlay{Capsule().strokeBorder(.white.opacity(0.2))}
        }
    }
}
