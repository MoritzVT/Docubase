import { describe, expect, it } from "vitest";
import { formatUsd, readableError } from "./presentation";

describe("formatUsd", () => {
  it("keeps sub-cent estimates visible", () => {
    expect(formatUsd(0.000286)).toBe("$0.0003");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("readableError", () => {
  it("does not expose Firebase's generic INTERNAL message", () => {
    expect(readableError(new Error("INTERNAL"))).toBe(
      "Docubase's cloud service hit an unexpected error. Existing data was preserved; try again in a moment.",
    );
  });

  it("keeps useful provider messages", () => {
    expect(readableError(new Error("Gemini batch expired."))).toBe(
      "Gemini batch expired.",
    );
  });
});
