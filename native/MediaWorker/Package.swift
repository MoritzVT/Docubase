// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "MediaWorker",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "MediaWorkerCore", targets: ["MediaWorkerCore"]),
        .executable(name: "MediaWorker", targets: ["MediaWorker"]),
    ],
    targets: [
        .target(
            name: "MediaWorkerCore",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("ImageIO"),
                .linkedFramework("Speech"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
        .executableTarget(
            name: "MediaWorker",
            dependencies: ["MediaWorkerCore"]
        ),
        .testTarget(
            name: "MediaWorkerCoreTests",
            dependencies: ["MediaWorkerCore"],
            swiftSettings: [
                .unsafeFlags([
                    "-F",
                    "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                ]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F",
                    "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker",
                    "-rpath",
                    "-Xlinker",
                    "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker",
                    "-rpath",
                    "-Xlinker",
                    "/Library/Developer/CommandLineTools/Library/Developer/usr/lib",
                ]),
            ]
        ),
    ]
)
