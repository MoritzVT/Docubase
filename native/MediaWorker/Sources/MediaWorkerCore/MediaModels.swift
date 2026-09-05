import Foundation

public struct MediaInspection: Codable, Sendable {
    public let durationMs: Int64
    public let frameRateNumerator: Int
    public let frameRateDenominator: Int
    public let dropFrame: Bool
    public let startTimecodeFrames: Int64?
    public let recordedAt: String?
    public let width: Int
    public let height: Int
    public let videoCodec: String
    public let audioCodec: String?
    public let hasAudio: Bool

    public init(
        durationMs: Int64,
        frameRateNumerator: Int,
        frameRateDenominator: Int,
        dropFrame: Bool,
        startTimecodeFrames: Int64?,
        recordedAt: String?,
        width: Int,
        height: Int,
        videoCodec: String,
        audioCodec: String?,
        hasAudio: Bool
    ) {
        self.durationMs = durationMs
        self.frameRateNumerator = frameRateNumerator
        self.frameRateDenominator = frameRateDenominator
        self.dropFrame = dropFrame
        self.startTimecodeFrames = startTimecodeFrames
        self.recordedAt = recordedAt
        self.width = width
        self.height = height
        self.videoCodec = videoCodec
        self.audioCodec = audioCodec
        self.hasAudio = hasAudio
    }
}

public struct AudioExtraction: Codable, Sendable {
    public let durationMs: Int64
    public let fileSizeBytes: Int64

    public init(durationMs: Int64, fileSizeBytes: Int64) {
        self.durationMs = durationMs
        self.fileSizeBytes = fileSizeBytes
    }
}

public struct RetainedFrame: Codable, Sendable {
    public let filename: String
    public let timestampMs: Int64
    public let width: Int
    public let height: Int
    public let fileSizeBytes: Int64
    public let changeScore: Double
}

public struct FrameExtraction: Codable, Sendable {
    public let sampledFrameCount: Int
    public let retainedFrames: [RetainedFrame]
    public let significantChangeCount: Int
    public let significantChangeRatio: Double
    public let medianChangeScore: Double
    public let maximumChangeScore: Double
}

public struct ResolvedFrameRate: Equatable, Sendable {
    public let numerator: Int
    public let denominator: Int

    public init(numerator: Int, denominator: Int) {
        self.numerator = numerator
        self.denominator = denominator
    }
}

public enum FrameRateResolver {
    public static func resolve(_ nominalRate: Float) -> ResolvedFrameRate {
        let knownRates: [(Float, ResolvedFrameRate)] = [
            (23.976, .init(numerator: 24_000, denominator: 1_001)),
            (29.97, .init(numerator: 30_000, denominator: 1_001)),
            (47.952, .init(numerator: 48_000, denominator: 1_001)),
            (59.94, .init(numerator: 60_000, denominator: 1_001)),
            (119.88, .init(numerator: 120_000, denominator: 1_001)),
        ]

        if let match = knownRates.first(where: {
            abs($0.0 - nominalRate) < 0.02
        }) {
            return match.1
        }

        return .init(
            numerator: max(1, Int(nominalRate.rounded())),
            denominator: 1
        )
    }
}

public enum MediaWorkerError: LocalizedError {
    case invalidArguments(String)
    case noVideoTrack
    case noAudioTrack
    case cannotCreateThumbnail
    case cannotCreateAudio
    case cannotReadTimecode

    public var errorDescription: String? {
        switch self {
        case let .invalidArguments(message):
            return message
        case .noVideoTrack:
            return "The file does not contain a readable video track."
        case .noAudioTrack:
            return "The file does not contain a readable audio track."
        case .cannotCreateThumbnail:
            return "A JPEG poster frame could not be created."
        case .cannotCreateAudio:
            return "The requested audio chunk could not be created."
        case .cannotReadTimecode:
            return "The embedded timecode track could not be read."
        }
    }
}
