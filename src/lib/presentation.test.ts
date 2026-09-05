import { describe, expect, it } from "vitest";
import { readableError } from "./presentation";

describe("readableError", () => {
  it("does not expose Firebase's generic INTERNAL message", () => {
    expect(readableError(new Error("INTERNAL"))).toBe(
      "The cloud analysis hit an unexpected error. Existing results were preserved; refresh the analysis to retry.",
    );
  });

  it("keeps useful provider messages", () => {
    expect(readableError(new Error("Gemini batch expired."))).toBe(
      "Gemini batch expired.",
    );
  });
});
