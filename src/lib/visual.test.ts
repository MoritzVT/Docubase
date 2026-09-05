import { describe, expect, it } from "vitest";
import type { VisualAnalysisJob } from "./contracts";
import {
  estimateVisualAnalysisCost,
  visualAnalysisProgressStage,
} from "./visual";

describe("visual analysis cost estimate", () => {
  it("uses current Gemini Batch image and output rates", () => {
    expect(estimateVisualAnalysisCost(360, 180)).toBe(0.062532);
    expect(estimateVisualAnalysisCost(360, 180, 1_000)).toBe(0.062682);
  });

  it("uses Standard pricing for Fast mode", () => {
    expect(
      estimateVisualAnalysisCost(360, 180, 0, 0, 0, 0, "fast"),
    ).toBe(0.125064);
  });

  it("charges no cost for an empty or invalid workload", () => {
    expect(estimateVisualAnalysisCost(0, 0)).toBe(0);
    expect(estimateVisualAnalysisCost(-10, -5)).toBe(0);
  });

  it("includes the separately approved whole-clip summary request", () => {
    expect(
      estimateVisualAnalysisCost(10, 5, 500, 1, 8, 1_000),
    ).toBe(0.002549);
  });
});

describe("visual analysis stage progress", () => {
  const job: VisualAnalysisJob = {
    id: "job",
    projectId: "project",
    clipId: "clip",
    kind: "clip",
    analysisMode: "batch",
    batchName: "batches/1",
    state: "running",
    phase: "foundation",
    route: null,
    analysisVersion: "4",
    momentIds: [],
    estimatedCostUsd: 0.001,
    actualCostUsd: null,
    error: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };

  it("reports honest milestones instead of a time-based percentage", () => {
    expect(visualAnalysisProgressStage(job)).toEqual({
      percent: 30,
      label: "Analyzing the transcript and interview-check image",
    });
    expect(
      visualAnalysisProgressStage({ ...job, phase: "visual" }).percent,
    ).toBe(85);
    expect(
      visualAnalysisProgressStage({
        ...job,
        state: "complete",
        phase: "complete",
      }).percent,
    ).toBe(100);
  });
});
