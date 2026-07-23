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
            let inspection = try await MediaInspector().inspect(
                mediaURL: URL(fileURLWithPath: arguments.mediaPath),
                thumbnailURL: URL(fileURLWithPath: arguments.thumbnailPath)
            )
            try writeJSON(inspection, to: FileHandle.standardOutput)
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

private struct CommandArguments {
    let mediaPath: String
    let thumbnailPath: String

    init(arguments: [String]) throws {
        guard arguments.first == "inspect" else {
            throw MediaWorkerError.invalidArguments(
                "Usage: MediaWorker inspect --path <video> --thumbnail <jpeg>"
            )
        }

        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag) else { return nil }
            let next = arguments.index(after: index)
            guard next < arguments.endIndex else { return nil }
            return arguments[next]
        }

        guard
            let mediaPath = value(after: "--path"),
            let thumbnailPath = value(after: "--thumbnail")
        else {
            throw MediaWorkerError.invalidArguments(
                "Both --path and --thumbnail are required."
            )
        }

        self.mediaPath = mediaPath
        self.thumbnailPath = thumbnailPath
    }
}
