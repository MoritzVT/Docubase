@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers
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
        async let commonMetadataValue = asset.load(.commonMetadata)

        let (
            duration,
            naturalSize,
            transform,
            nominalRate,
            videoDescriptions,
            audioTracks,
            commonMetadata
        ) = try await (
            durationValue,
            naturalSizeValue,
            transformValue,
            nominalRateValue,
            videoDescriptionsValue,
            audioTracksValue,
            commonMetadataValue
        )

        let audioCodec = try await codecName(for: audioTracks.first)
        let rate = FrameRateResolver.resolve(nominalRate)
        let timecode = try await readTimecode(from: asset)
        let transformedSize = naturalSize.applying(transform)
        let recordedAt = await recordingDate(from: commonMetadata)?.ISO8601Format()

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
            recordedAt: recordedAt,
            width: Int(abs(transformedSize.width).rounded()),
            height: Int(abs(transformedSize.height).rounded()),
            videoCodec: codecName(from: videoDescriptions.first) ?? "unknown",
            audioCodec: audioCodec,
            hasAudio: !audioTracks.isEmpty
        )
    }

    private func recordingDate(from metadata: [AVMetadataItem]) async -> Date? {
        for item in metadata where item.commonKey == .commonKeyCreationDate {
            if let date = try? await item.load(.dateValue) {
                return date
            }
            if let value = try? await item.load(.stringValue) {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let date = formatter.date(from: value) {
                    return date
                }
                formatter.formatOptions = [.withInternetDateTime]
                if let date = formatter.date(from: value) {
                    return date
                }
            }
        }
        return nil
    }

    public func extractAudio(
        mediaURL: URL,
        outputURL: URL,
        startMs: Int64,
        durationMs: Int64
    ) async throws -> AudioExtraction {
        let asset = AVURLAsset(url: mediaURL)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard !audioTracks.isEmpty else {
            throw MediaWorkerError.noAudioTrack
        }

        let assetDuration = try await asset.load(.duration)
        let assetDurationSeconds = max(0, CMTimeGetSeconds(assetDuration))
        let startSeconds = Double(startMs) / 1_000
        guard startSeconds < assetDurationSeconds else {
            throw MediaWorkerError.cannotCreateAudio
        }
        let requestedDurationSeconds = Double(durationMs) / 1_000
        let actualDurationSeconds = min(
            requestedDurationSeconds,
            assetDurationSeconds - startSeconds
        )
        let startTime = CMTime(seconds: startSeconds, preferredTimescale: 48_000)
        let chunkDuration = CMTime(
            seconds: actualDurationSeconds,
            preferredTimescale: 48_000
        )

        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.removeItem(at: outputURL)

        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: startTime, duration: chunkDuration)
        let readerOutput = AVAssetReaderAudioMixOutput(
            audioTracks: audioTracks,
            audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
        )
        readerOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(readerOutput) else {
            throw MediaWorkerError.cannotCreateAudio
        }
        reader.add(readerOutput)

        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
        let writerInput = AVAssetWriterInput(
            mediaType: .audio,
            outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 48_000,
            ]
        )
        writerInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(writerInput) else {
            throw MediaWorkerError.cannotCreateAudio
        }
        writer.add(writerInput)

        guard writer.startWriting() else {
            throw writer.error ?? MediaWorkerError.cannotCreateAudio
        }
        writer.startSession(atSourceTime: startTime)
        guard reader.startReading() else {
            throw reader.error ?? MediaWorkerError.cannotCreateAudio
        }

        while let sampleBuffer = readerOutput.copyNextSampleBuffer() {
            while !writerInput.isReadyForMoreMediaData {
                try await Task.sleep(for: .milliseconds(2))
            }
            guard writerInput.append(sampleBuffer) else {
                reader.cancelReading()
                throw writer.error ?? MediaWorkerError.cannotCreateAudio
            }
        }

        writerInput.markAsFinished()
        await withCheckedContinuation { continuation in
            writer.finishWriting {
                continuation.resume()
            }
        }

        guard
            reader.status == .completed,
            writer.status == .completed
        else {
            throw writer.error
                ?? reader.error
                ?? MediaWorkerError.cannotCreateAudio
        }

        let attributes = try FileManager.default.attributesOfItem(
            atPath: outputURL.path
        )
        let fileSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        return AudioExtraction(
            durationMs: Int64((actualDurationSeconds * 1_000).rounded()),
            fileSizeBytes: fileSize
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
}
