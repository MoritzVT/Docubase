@preconcurrency import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

extension MediaInspector {
    public func extractAdaptiveFrames(
        mediaURL: URL,
        outputDirectoryURL: URL
    ) async throws -> FrameExtraction {
        let asset = AVURLAsset(url: mediaURL)
        guard try await !asset.loadTracks(withMediaType: .video).isEmpty else {
            throw MediaWorkerError.noVideoTrack
        }
        let duration = try await asset.load(.duration)
        let durationSeconds = max(0, CMTimeGetSeconds(duration))
        guard durationSeconds > 0 else {
            throw MediaWorkerError.cannotCreateThumbnail
        }

        try FileManager.default.createDirectory(
            at: outputDirectoryURL,
            withIntermediateDirectories: true
        )
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 384, height: 384)
        generator.requestedTimeToleranceBefore = CMTime(
            seconds: 0.25,
            preferredTimescale: 600
        )
        generator.requestedTimeToleranceAfter = CMTime(
            seconds: 0.25,
            preferredTimescale: 600
        )

        struct Candidate {
            let image: CGImage
            let timestampMs: Int64
            let changeScore: Double
        }

        let bucketSeconds = 5
        let sampleCount = max(1, Int(ceil(durationSeconds)))
        let bucketCount = max(1, Int(ceil(durationSeconds / Double(bucketSeconds))))
        var previousSignature: [UInt8]?
        var retained: [RetainedFrame] = []
        var lastRetainedMs: Int64?
        var sampledFrameCount = 0
        var sampledChangeScores: [Double] = []

        for bucketIndex in 0..<bucketCount {
            let bucketStart = bucketIndex * bucketSeconds
            let bucketEnd = min(
                sampleCount,
                bucketStart + bucketSeconds
            )
            var bestCandidate: Candidate?

            for sampleSecond in bucketStart..<bucketEnd {
                let requestedSeconds = min(
                    Double(sampleSecond),
                    max(0, durationSeconds - 0.001)
                )
                let requestedTime = CMTime(
                    seconds: requestedSeconds,
                    preferredTimescale: 600
                )
                let (image, actualTime) = try await generator.image(
                    at: requestedTime
                )
                sampledFrameCount += 1
                let signature = grayscaleSignature(for: image)
                let hadPreviousFrame = previousSignature != nil
                let score = previousSignature.map {
                    visualDifference($0, signature)
                } ?? 1
                previousSignature = signature
                if hadPreviousFrame {
                    sampledChangeScores.append(score)
                }
                let actualSeconds = max(0, CMTimeGetSeconds(actualTime))
                let candidate = Candidate(
                    image: image,
                    timestampMs: Int64((actualSeconds * 1_000).rounded()),
                    changeScore: score
                )
                if
                    bestCandidate == nil
                        || score > (bestCandidate?.changeScore ?? 0)
                {
                    bestCandidate = candidate
                }
            }

            guard let candidate = bestCandidate else { continue }
            let millisecondsSinceLast = lastRetainedMs.map {
                candidate.timestampMs - $0
            }
            let shouldRetain =
                retained.isEmpty
                || candidate.changeScore >= 0.085
                || (millisecondsSinceLast ?? 30_000) >= 30_000
                || bucketIndex == bucketCount - 1
            guard shouldRetain else { continue }

            let filename = String(
                format: "frame-%012lld.jpg",
                candidate.timestampMs
            )
            let outputURL = outputDirectoryURL.appendingPathComponent(filename)
            let fileSize = try writeRetainedJPEG(
                candidate.image,
                to: outputURL
            )
            retained.append(
                RetainedFrame(
                    filename: filename,
                    timestampMs: candidate.timestampMs,
                    width: candidate.image.width,
                    height: candidate.image.height,
                    fileSizeBytes: fileSize,
                    changeScore: candidate.changeScore
                )
            )
            lastRetainedMs = candidate.timestampMs
        }

        let sortedScores = sampledChangeScores.sorted()
        let significantChangeCount = sortedScores.filter { $0 >= 0.085 }.count
        let medianChangeScore: Double
        if sortedScores.isEmpty {
            medianChangeScore = 1
        } else if sortedScores.count.isMultiple(of: 2) {
            let upper = sortedScores.count / 2
            medianChangeScore = (sortedScores[upper - 1] + sortedScores[upper]) / 2
        } else {
            medianChangeScore = sortedScores[sortedScores.count / 2]
        }
        return FrameExtraction(
            sampledFrameCount: sampledFrameCount,
            retainedFrames: retained,
            significantChangeCount: significantChangeCount,
            significantChangeRatio: sortedScores.isEmpty
                ? 1
                : Double(significantChangeCount) / Double(sortedScores.count),
            medianChangeScore: medianChangeScore,
            maximumChangeScore: sortedScores.max() ?? 1
        )
    }
    func createThumbnail(
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

    func grayscaleSignature(for image: CGImage) -> [UInt8] {
        let width = 32
        let height = 18
        var pixels = [UInt8](repeating: 0, count: width * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard
                let baseAddress = buffer.baseAddress,
                let context = CGContext(
                    data: baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: width,
                    space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.none.rawValue
                )
            else {
                return
            }
            context.interpolationQuality = .low
            context.draw(
                image,
                in: CGRect(x: 0, y: 0, width: width, height: height)
            )
        }
        return pixels
    }

    func visualDifference(
        _ left: [UInt8],
        _ right: [UInt8]
    ) -> Double {
        guard left.count == right.count, !left.isEmpty else { return 1 }
        let difference = zip(left, right).reduce(0.0) { total, pair in
            total + abs(Double(pair.0) - Double(pair.1))
        }
        return min(1, difference / (Double(left.count) * 255))
    }

    func writeJPEG(
        _ image: CGImage,
        to outputURL: URL,
        quality: Double
    ) throws {
        try? FileManager.default.removeItem(at: outputURL)
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
            [
                kCGImageDestinationLossyCompressionQuality:
                    min(1, max(0, quality)),
            ] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw MediaWorkerError.cannotCreateThumbnail
        }
    }

    func writeRetainedJPEG(
        _ image: CGImage,
        to outputURL: URL
    ) throws -> Int64 {
        let maximumBytes: Int64 = 100 * 1_024
        for quality in [0.68, 0.54, 0.42, 0.30, 0.22] {
            try writeJPEG(image, to: outputURL, quality: quality)
            let attributes = try FileManager.default.attributesOfItem(
                atPath: outputURL.path
            )
            let fileSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0
            if fileSize > 0, fileSize <= maximumBytes {
                return fileSize
            }
        }
        throw MediaWorkerError.cannotCreateThumbnail
    }
}
