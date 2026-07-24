import { describe, expect, it } from "vitest";
import { estimateTranscriptionCost } from "./transcription";

describe("transcription cost estimate", () => {
  it("prices Nova-3 and diarization for an hour", () => {
    expect(estimateTranscriptionCost(60 * 60 * 1_000)).toBe(0.408);
  });

  it("prices a thirty-minute chunk", () => {
    expect(estimateTranscriptionCost(30 * 60 * 1_000)).toBe(0.204);
  });

  it("does not return a negative estimate", () => {
    expect(estimateTranscriptionCost(-1)).toBe(0);
  });
});
