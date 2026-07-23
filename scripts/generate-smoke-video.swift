import AVFoundation
import CoreVideo
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift generate-smoke-video.swift <output.mov>\n", stderr)
    exit(EXIT_FAILURE)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: outputURL)

let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
let width = 640
let height = 360
let videoInput = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
    ]
)
videoInput.expectsMediaDataInRealTime = false

let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: videoInput,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String:
            kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
    ]
)

guard writer.canAdd(videoInput) else {
    fputs("Could not add the video input.\n", stderr)
    exit(EXIT_FAILURE)
}
writer.add(videoInput)
guard writer.startWriting() else {
    throw writer.error ?? CocoaError(.fileWriteUnknown)
}
writer.startSession(atSourceTime: .zero)

for frameIndex in 0..<50 {
    while !videoInput.isReadyForMoreMediaData {
        Thread.sleep(forTimeInterval: 0.002)
    }

    var pixelBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        nil,
        &pixelBuffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer else {
        fputs("Could not allocate a frame.\n", stderr)
        exit(EXIT_FAILURE)
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let base = CVPixelBufferGetBaseAddress(pixelBuffer)!
        .assumingMemoryBound(to: UInt8.self)
    for y in 0..<height {
        let row = base.advanced(by: y * bytesPerRow)
        for x in 0..<width {
            let pixel = row.advanced(by: x * 4)
            pixel[0] = UInt8((x + frameIndex * 3) % 255)
            pixel[1] = UInt8((y * 2) % 255)
            pixel[2] = UInt8((frameIndex * 5) % 255)
            pixel[3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

    guard adaptor.append(
        pixelBuffer,
        withPresentationTime: CMTime(value: CMTimeValue(frameIndex), timescale: 25)
    ) else {
        throw writer.error ?? CocoaError(.fileWriteUnknown)
    }
}

videoInput.markAsFinished()
let completion = DispatchSemaphore(value: 0)
writer.finishWriting {
    completion.signal()
}
completion.wait()

guard writer.status == .completed else {
    throw writer.error ?? CocoaError(.fileWriteUnknown)
}
print(outputURL.path)
