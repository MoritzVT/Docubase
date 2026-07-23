import Testing
@testable import MediaWorkerCore

@Suite("Frame-rate resolution")
struct FrameRateResolverTests {
    @Test
    func resolvesIntegerRate() {
        #expect(
            FrameRateResolver.resolve(25)
            == ResolvedFrameRate(numerator: 25, denominator: 1)
        )
    }

    @Test
    func resolvesNTSCFractionalRate() {
        #expect(
            FrameRateResolver.resolve(29.97)
            == ResolvedFrameRate(numerator: 30_000, denominator: 1_001)
        )
    }

    @Test
    func resolvesCinemaFractionalRate() {
        #expect(
            FrameRateResolver.resolve(23.976)
            == ResolvedFrameRate(numerator: 24_000, denominator: 1_001)
        )
    }
}
