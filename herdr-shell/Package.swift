// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HerdrShell",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "herdr-shell", targets: ["HerdrShell"])
    ],
    targets: [
        .executableTarget(name: "HerdrShell")
    ]
)
