@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct MediaInspection: Codable, Sendable {
    public let durationMs: Int64
    public let frameRateNumerator: Int
    public let frameRateDenominator: Int
    public let dropFrame: Bool
    public let startTimecodeFrames: Int64?
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
        self.width = width
        self.height = height
        self.videoCodec = videoCodec
        self.audioCodec = audioCodec
        self.hasAudio = hasAudio
    }
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
    case cannotCreateThumbnail
    case cannotReadTimecode

    public var errorDescription: String? {
        switch self {
        case let .invalidArguments(message):
            return message
        case .noVideoTrack:
            return "The file does not contain a readable video track."
        case .cannotCreateThumbnail:
            return "A JPEG poster frame could not be created."
        case .cannotReadTimecode:
            return "The embedded timecode track could not be read."
        }
    }
}

public actor MediaInspector {
    public init() {}

    public func inspect(
        mediaURL: URL,
        thumbnailURL: URL
    ) async throws -> MediaInspection {
        let asset = AVURLAsset(url: mediaURL)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let videoTrack = videoTracks.first else {
            throw MediaWorkerError.noVideoTrack
        }

        async let durationValue = asset.load(.duration)
        async let naturalSizeValue = videoTrack.load(.naturalSize)
        async let transformValue = videoTrack.load(.preferredTransform)
        async let nominalRateValue = videoTrack.load(.nominalFrameRate)
        async let videoDescriptionsValue = videoTrack.load(.formatDescriptions)
        async let audioTracksValue = asset.loadTracks(withMediaType: .audio)

        let (
            duration,
            naturalSize,
            transform,
            nominalRate,
            videoDescriptions,
            audioTracks
        ) = try await (
            durationValue,
            naturalSizeValue,
            transformValue,
            nominalRateValue,
            videoDescriptionsValue,
            audioTracksValue
        )

        let audioCodec = try await codecName(for: audioTracks.first)
        let rate = FrameRateResolver.resolve(nominalRate)
        let timecode = try await readTimecode(from: asset)
        let transformedSize = naturalSize.applying(transform)

        try FileManager.default.createDirectory(
            at: thumbnailURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try await createThumbnail(
            from: asset,
            duration: duration,
            at: thumbnailURL
        )

        return MediaInspection(
            durationMs: Int64(
                max(0, CMTimeGetSeconds(duration) * 1_000).rounded()
            ),
            frameRateNumerator: rate.numerator,
            frameRateDenominator: rate.denominator,
            dropFrame: timecode?.dropFrame ?? false,
            startTimecodeFrames: timecode?.frameNumber,
            width: Int(abs(transformedSize.width).rounded()),
            height: Int(abs(transformedSize.height).rounded()),
            videoCodec: codecName(from: videoDescriptions.first) ?? "unknown",
            audioCodec: audioCodec,
            hasAudio: !audioTracks.isEmpty
        )
    }

    private func codecName(for track: AVAssetTrack?) async throws -> String? {
        guard let track else { return nil }
        let descriptions = try await track.load(.formatDescriptions)
        return codecName(from: descriptions.first)
    }

    private func codecName(from description: CMFormatDescription?) -> String? {
        guard let description else { return nil }
        let subtype = CMFormatDescriptionGetMediaSubType(description)
        let bytes: [UInt8] = [
            UInt8((subtype >> 24) & 0xff),
            UInt8((subtype >> 16) & 0xff),
            UInt8((subtype >> 8) & 0xff),
            UInt8(subtype & 0xff),
        ]
        let printable = bytes.map { byte in
            (32...126).contains(byte) ? Character(UnicodeScalar(byte)) : "?"
        }
        return String(printable)
    }

    private func createThumbnail(
        from asset: AVAsset,
        duration: CMTime,
        at outputURL: URL
    ) async throws {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 360)

        let durationSeconds = max(0, CMTimeGetSeconds(duration))
        let thumbnailSecond = min(1, durationSeconds * 0.1)
        let time = CMTime(seconds: thumbnailSecond, preferredTimescale: 600)
        let (image, _) = try await generator.image(at: time)

        guard
            let destination = CGImageDestinationCreateWithURL(
                outputURL as CFURL,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            )
        else {
            throw MediaWorkerError.cannotCreateThumbnail
        }

        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw MediaWorkerError.cannotCreateThumbnail
        }
    }

    private struct EmbeddedTimecode {
        let frameNumber: Int64
        let dropFrame: Bool
    }

    private func readTimecode(
        from asset: AVAsset
    ) async throws -> EmbeddedTimecode? {
        guard
            let track = try await asset.loadTracks(withMediaType: .timecode).first
        else {
            return nil
        }

        let descriptions = try await track.load(.formatDescriptions)
        let dropFrame = descriptions.first.map {
            CMTimeCodeFormatDescriptionGetTimeCodeFlags($0)
                & kCMTimeCodeFlag_DropFrame != 0
        } ?? false

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        guard reader.canAdd(output) else {
            throw MediaWorkerError.cannotReadTimecode
        }
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? MediaWorkerError.cannotReadTimecode
        }
        guard
            let sample = output.copyNextSampleBuffer(),
            let block = CMSampleBufferGetDataBuffer(sample)
        else {
            return nil
        }

        let length = CMBlockBufferGetDataLength(block)
        var bytes = [UInt8](repeating: 0, count: length)
        let status = CMBlockBufferCopyDataBytes(
            block,
            atOffset: 0,
            dataLength: length,
            destination: &bytes
        )
        guard status == kCMBlockBufferNoErr else {
            throw MediaWorkerError.cannotReadTimecode
        }

        let frameNumber: Int64
        if bytes.count >= 8 {
            frameNumber = bytes.prefix(8).reduce(Int64(0)) {
                ($0 << 8) | Int64($1)
            }
        } else if bytes.count >= 4 {
            frameNumber = bytes.prefix(4).reduce(Int64(0)) {
                ($0 << 8) | Int64($1)
            }
        } else {
            return nil
        }

        return EmbeddedTimecode(
            frameNumber: frameNumber,
            dropFrame: dropFrame
        )
    }
}
