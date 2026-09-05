@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import Speech

public struct AppleSpeechTranscriber: Sendable {
    public init() {}

    public func transcribe(
        audioURL: URL,
        localeIdentifier: String,
        contextualTerms: [String]
    ) async throws -> SpeechTranscription {
        guard SpeechTranscriber.isAvailable else {
            throw MediaWorkerError.speechTranscriptionUnavailable
        }

        let requestedLocale = Locale(identifier: localeIdentifier)
        guard let locale = await SpeechTranscriber.supportedLocale(
            equivalentTo: requestedLocale
        ) else {
            throw MediaWorkerError.unsupportedSpeechLocale(localeIdentifier)
        }

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence]
        )
        let modules: [any SpeechModule] = [transcriber]

        if let installation = try await AssetInventory.assetInstallationRequest(
            supporting: modules
        ) {
            try await installation.downloadAndInstall()
        }

        let context = AnalysisContext()
        let terms = contextualTerms
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if !terms.isEmpty {
            context.contextualStrings[.general] = Array(Set(terms)).sorted()
        }

        let audioFile = try AVAudioFile(forReading: audioURL)
        let analyzer = SpeechAnalyzer(modules: modules)
        try await analyzer.setContext(context)

        async let collectedSegments = collectFinalSegments(from: transcriber)
        do {
            if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            let segments = try await collectedSegments
            return SpeechTranscription(
                locale: locale.identifier(.bcp47),
                model: "Apple SpeechTranscriber",
                modelVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                segments: segments
            )
        } catch {
            await analyzer.cancelAndFinishNow()
            throw error
        }
    }

    private func collectFinalSegments(
        from transcriber: SpeechTranscriber
    ) async throws -> [SpeechSegment] {
        var segments: [SpeechSegment] = []
        for try await result in transcriber.results where result.isFinal {
            let text = String(result.text.characters)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }

            let words = timedWords(in: result.text)
            let confidences = words.map(\.confidence)
            let confidence = confidences.isEmpty
                ? 0
                : confidences.reduce(0, +) / Double(confidences.count)
            segments.append(
                SpeechSegment(
                    text: text,
                    startMs: milliseconds(result.range.start),
                    endMs: milliseconds(result.range.end),
                    confidence: confidence,
                    words: words
                )
            )
        }
        return segments
    }

    private func timedWords(in text: AttributedString) -> [SpeechWord] {
        text.runs.compactMap { run in
            let value = String(text[run.range].characters)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard
                !value.isEmpty,
                let range = run.audioTimeRange
            else {
                return nil
            }
            return SpeechWord(
                text: value,
                startMs: milliseconds(range.start),
                endMs: milliseconds(range.end),
                confidence: bounded(run.transcriptionConfidence ?? 0)
            )
        }
    }

    private func milliseconds(_ time: CMTime) -> Int64 {
        let seconds = CMTimeGetSeconds(time)
        guard seconds.isFinite else { return 0 }
        return Int64((max(0, seconds) * 1_000).rounded())
    }

    private func bounded(_ confidence: Double) -> Double {
        confidence.isFinite ? confidence.clamped(to: 0...1) : 0
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
