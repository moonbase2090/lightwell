// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SwiftSample",
    products: [
        .library(name: "Greeting", targets: ["Greeting"]),
        .executable(name: "Demo", targets: ["Demo"]),
    ],
    targets: [
        .target(name: "Greeting"),
        .executableTarget(name: "Demo", dependencies: ["Greeting"]),
    ]
)
