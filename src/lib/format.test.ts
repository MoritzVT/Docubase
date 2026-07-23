import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatFrameRate } from "./format";

describe("catalog formatting", () => {
  it("formats documentary-length durations", () => {
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("formats retained source sizes", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GB");
  });

  it("preserves fractional frame rates", () => {
    expect(formatFrameRate(24_000, 1_001)).toBe("23.98");
  });
});
