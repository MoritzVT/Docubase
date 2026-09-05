import Foundation
import MediaWorkerCore

private struct WorkerError: Encodable {
    let error: String
}

@main
struct MediaWorkerCommand {
    static func main() async {
        do {
            let arguments = try CommandArguments(
                arguments: Array(CommandLine.arguments.dropFirst())
            )
            let inspector = MediaInspector()
            switch arguments {
            case let .inspect(mediaPath, thumbnailPath):
                let inspection = try await inspector.inspect(
                    mediaURL: URL(fileURLWithPath: mediaPath),
                    thumbnailURL: URL(fileURLWithPath: thumbnailPath)
                )
                try writeJSON(inspection, to: FileHandle.standardOutput)
            case let .extractAudio(mediaPath, outputPath, startMs, durationMs):
                let extraction = try await inspector.extractAudio(
                    mediaURL: URL(fileURLWithPath: mediaPath),
                    outputURL: URL(fileURLWithPath: outputPath),
                    startMs: startMs,
                    durationMs: durationMs
                )
                try writeJSON(extraction, to: FileHandle.standardOutput)
            case let .extractFrames(mediaPath, outputDirectoryPath):
                let extraction = try await inspector.extractAdaptiveFrames(
                    mediaURL: URL(fileURLWithPath: mediaPath),
                    outputDirectoryURL: URL(
                        fileURLWithPath: outputDirectoryPath,
                        isDirectory: true
                    )
                )
                try writeJSON(extraction, to: FileHandle.standardOutput)
            }
        } catch {
            try? writeJSON(
                WorkerError(error: error.localizedDescription),
                to: FileHandle.standardError
            )
            Foundation.exit(EXIT_FAILURE)
        }
    }

    private static func writeJSON<Value: Encodable>(
        _ value: Value,
        to handle: FileHandle
    ) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var data = try encoder.encode(value)
        data.append(0x0A)
        try handle.write(contentsOf: data)
    }
}

private enum CommandArguments {
    case inspect(mediaPath: String, thumbnailPath: String)
    case extractAudio(
        mediaPath: String,
        outputPath: String,
        startMs: Int64,
        durationMs: Int64
    )
    case extractFrames(mediaPath: String, outputDirectoryPath: String)

    init(arguments: [String]) throws {
        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag) else { return nil }
            let next = arguments.index(after: index)
            guard next < arguments.endIndex else { return nil }
            return arguments[next]
        }

        guard let command = arguments.first else {
            throw MediaWorkerError.invalidArguments(
                "Expected inspect or extract-audio."
            )
        }

        switch command {
        case "inspect":
            guard
                let mediaPath = value(after: "--path"),
                let thumbnailPath = value(after: "--thumbnail")
            else {
                throw MediaWorkerError.invalidArguments(
                    "Usage: MediaWorker inspect --path <video> --thumbnail <jpeg>"
                )
            }
            self = .inspect(
                mediaPath: mediaPath,
                thumbnailPath: thumbnailPath
            )
        case "extract-audio":
            guard
                let mediaPath = value(after: "--path"),
                let outputPath = value(after: "--output"),
                let startValue = value(after: "--start-ms"),
                let durationValue = value(after: "--duration-ms"),
                let startMs = Int64(startValue),
                let durationMs = Int64(durationValue),
                startMs >= 0,
                durationMs > 0
            else {
                throw MediaWorkerError.invalidArguments(
                    "Usage: MediaWorker extract-audio --path <video> --output <m4a> --start-ms <ms> --duration-ms <ms>"
                )
            }
            self = .extractAudio(
                mediaPath: mediaPath,
                outputPath: outputPath,
                startMs: startMs,
                durationMs: durationMs
            )
        case "extract-frames":
            guard
                let mediaPath = value(after: "--path"),
                let outputDirectoryPath = value(after: "--output-directory")
            else {
                throw MediaWorkerError.invalidArguments(
                    "Usage: MediaWorker extract-frames --path <video> --output-directory <directory>"
                )
            }
            self = .extractFrames(
                mediaPath: mediaPath,
                outputDirectoryPath: outputDirectoryPath
            )
        default:
            throw MediaWorkerError.invalidArguments(
                "Expected inspect, extract-audio, or extract-frames."
            )
        }
    }
}
