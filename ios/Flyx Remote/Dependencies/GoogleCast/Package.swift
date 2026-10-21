// swift-tools-version:5.7
import PackageDescription

// Use the unchanged official dynamic binary once. SDK4.8.6's upstream wrapper
// also links a static GTMSessionFetcher copy already embedded in this framework.
let package = Package(
    name: "FlyxGoogleCast",
    platforms: [.iOS(.v16)],
    products: [.library(name: "GoogleCastDynamic", targets: ["GoogleCast"])],
    targets: [.binaryTarget(
        name: "GoogleCast",
        url: "https://dl.google.com/dl/chromecast/sdk/ios/GoogleCastSDK-ios-4.8.6_dynamic.zip",
        checksum: "55f6c21291a1315c68063f07e7d76225564bff70f2fd38caad135c71d66eb310"
    )]
)
