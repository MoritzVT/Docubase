import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateVisualStability,
  chooseVisualRoute,
  mergeClipAnalysis,
  normalizeKeywords,
  partitionCompleteTranscript,
  sanitizeTranscriptAnalysis,
  sanitizeVisualRoutingAnalysis,
} from "../lib/analysis-pipeline.js";
import {
  requireVisualFrameManifest,
  visualPromptContext,
  visualMomentPrompt,
} from "../lib/visual/requests.js";
import {
  analysisMode,
  analysisOperation,
} from "../lib/visual/execution.js";
import { estimateVisualCost } from "../lib/usage.js";

const utterance = (id, startMs, text) => ({
  id,
  startMs,
  endMs: startMs + 900,
  speaker: 0,
  text,
});

test("Batch stays the default and Fast mode uses Standard pricing", () => {
  assert.equal(analysisMode(undefined), "batch");
  assert.equal(analysisMode("fast"), "fast");
  assert.match(analysisOperation("fast"), /standard/);
  assert.equal(
    estimateVisualCost(360, 180, 0, 0, 0, 0, "fast"),
    2 * estimateVisualCost(360, 180),
  );
});

test("complete transcript partitioning preserves every utterance in order", () => {
  const input = [
    utterance("first", 0, "The opening subject."),
    utterance("middle", 1_000, "The central explanation."),
    utterance("last", 2_000, "The conclusion."),
  ];
  const sections = partitionCompleteTranscript(input, 75, 10_000, 10_000);
  assert.ok(sections.length > 1);
  assert.deepEqual(
    sections.flatMap((section) => section.utterances.map((item) => item.id)),
    ["first", "middle", "last"],
  );
  assert.match(sections.map((section) => section.text).join("\n"), /middle/);
});

test("transcript analysis accepts only supplied evidence", () => {
  const result = sanitizeTranscriptAnalysis({
    summary: "Interview footage about community climate fundraising.",
    speechFormat: "interview",
    subjects: ["Climate fundraising"],
    keywords: ["fundraising", "Documentary", "fundraising"],
    namedEntities: ["Joost"],
    evidenceUtteranceIds: ["u1", "invented"],
    confidence: 0.9,
  }, ["u1", "u2"]);
  assert.deepEqual(result.evidenceUtteranceIds, ["u1"]);
  assert.deepEqual(result.keywords, ["fundraising"]);
  assert.equal(result.speechFormat, "interview");
});

test("visual routing accepts only frame evidence", () => {
  const result = sanitizeVisualRoutingAnalysis({
    composition: "interview-like",
    description: "A seated speaker faces an off-camera interviewer.",
    keywords: ["seated speaker", "person", "medium shot"],
    evidenceFrameIds: ["frame-1", "utterance-1"],
    confidence: 0.95,
  }, ["frame-1"]);
  assert.deepEqual(result.evidenceFrameIds, ["frame-1"]);
  assert.deepEqual(result.keywords, ["seated speaker", "medium shot"]);
});

test("stable interview routing requires all three high-confidence signals", () => {
  const transcript = {
    summary: "An interview about adoption.",
    speechFormat: "interview",
    subjects: ["adoption"],
    keywords: ["animal shelter"],
    namedEntities: [],
    evidenceUtteranceIds: ["u1"],
    confidence: 0.93,
  };
  const visual = {
    composition: "interview-like",
    description: "A seated speaker in a medium shot.",
    keywords: ["seated speaker"],
    evidenceFrameIds: ["f1"],
    confidence: 0.91,
  };
  const stable = calculateVisualStability([0.01, 0.02, 0.03, 0.04]);
  assert.equal(chooseVisualRoute(transcript, visual, stable), "stableInterview");
  assert.equal(
    chooseVisualRoute(
      transcript,
      { ...visual, composition: "mixed-or-uncertain" },
      stable,
    ),
    "fullVisual",
  );
  assert.equal(
    chooseVisualRoute(transcript, visual, calculateVisualStability([0.02, 0.8])),
    "fullVisual",
  );
});

test("clip merge prioritizes transcript meaning and keeps keyword provenance", () => {
  const result = mergeClipAnalysis({
    summary: "Interview footage about Max being adopted after 270 days at a shelter.",
    speechFormat: "interview",
    subjects: ["dog adoption"],
    keywords: ["animal shelter", "Max"],
    namedEntities: ["Max"],
    evidenceUtteranceIds: ["u1"],
    confidence: 0.9,
  }, ["A woman is seated indoors in a medium interview shot."], [
    "woman",
    "indoor",
    "medium shot",
  ], ["f1"]);
  assert.match(result.description, /^Interview footage about Max/);
  assert.match(result.description, /woman is seated indoors/);
  assert.deepEqual(result.tags.slice(0, 3), ["Max", "dog adoption", "animal shelter"]);
  assert.deepEqual(
    result.keywordProvenance.find((item) => item.value === "Max")?.sources,
    ["transcript"],
  );
  assert.deepEqual(
    result.keywordProvenance.find((item) => item.value === "medium shot")
      ?.evidenceFrameIds,
    ["f1"],
  );
});

test("keyword normalization removes generic and repeated values", () => {
  assert.deepEqual(
    normalizeKeywords([" Video ", "Cycling", "cycling", "mountain.", "person"]),
    ["Cycling", "mountain"],
  );
});

test("visual moment prompts contain frames but no transcript evidence", () => {
  const prompt = visualMomentPrompt(
    { brief: "A cycling documentary", knownNames: [], terminology: [] },
    { filename: "ride.mov" },
    {
      id: "moment-1",
      startMs: 0,
      endMs: 15_000,
      frames: [{ id: "frame-1" }],
    },
  );
  assert.match(prompt, /frame-1/);
  assert.match(prompt, /No transcript evidence is provided/);
  assert.doesNotMatch(prompt, /utterance|Transcript evidence:/i);
});

test("project text resources are labeled as background rather than evidence", () => {
  const context = visualPromptContext(
    {
      brief: "A cycling documentary",
      knownNames: ["Joost"],
      terminology: ["climate finance"],
      contextText: "Source: research.txt\nCycling4Climate organizes the ride.",
    },
    { filename: "ride.mov" },
  );
  assert.match(context, /Cycling4Climate organizes the ride/);
  assert.match(context, /not evidence that anything is said or visible/i);
});

test("local frame manifests derive their protected storage paths", () => {
  const frame = requireVisualFrameManifest({
    id: "frame-000000015000",
    momentId: "moment-00000001",
    timestampMs: 15_000,
    fileSizeBytes: 42_000,
    changeScore: 0.04,
  }, "project-1", "clip-1");
  assert.equal(
    frame.storagePath,
    "projects/project-1/clips/clip-1/frames/frame-000000015000.jpg",
  );
  assert.equal(frame.changeScore, 0.04);
});
