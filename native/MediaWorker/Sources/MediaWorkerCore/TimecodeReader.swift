@preconcurrency import AVFoundation
import CoreMedia
import Foundation

extension MediaInspector {
    struct EmbeddedTimecode {
        let frameNumber: Int64
        let dropFrame: Bool
    }

    func readTimecode(
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
