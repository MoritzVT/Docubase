import { describe, expect, it } from "vitest";
import { clipTimecode, framesToTimecode } from "./timecode";

describe("framesToTimecode", () => {
  it("formats 25 fps timecode", () => {
    expect(
      framesToTimecode(25 * 3661 + 12, {
        numerator: 25,
        denominator: 1,
        dropFrame: false,
      }),
    ).toBe("01:01:01:12");
  });

  it("formats 23.976 footage with a nominal 24 frame counter", () => {
    expect(
      framesToTimecode(24 * 60, {
        numerator: 24000,
        denominator: 1001,
        dropFrame: false,
      }),
    ).toBe("00:01:00:00");
  });

  it("formats 29.97 drop-frame at the ten-minute boundary", () => {
    expect(
      framesToTimecode(17_982, {
        numerator: 30000,
        denominator: 1001,
        dropFrame: true,
      }),
    ).toBe("00:10:00;00");
  });

  it("adds the source start timecode", () => {
    expect(
      clipTimecode(
        1000,
        { numerator: 25, denominator: 1, dropFrame: false },
        90_000,
      ),
    ).toBe("01:00:01:00");
  });
});
