import assert from "node:assert/strict";
import test from "node:test";
import {
  extractGeminiResponseText,
  normalizeVisualMomentPayload,
} from "../lib/gemini-response.js";

test("extracts text from a plain Batch response candidate", () => {
  const response = {
    candidates: [
      {
        content: {
          parts: [
            { text: "{\"description\":" },
            { text: "\"A cyclist climbs.\"}" },
          ],
        },
      },
    ],
  };

  assert.equal(
    extractGeminiResponseText(response),
    "{\"description\":\"A cyclist climbs.\"}",
  );
});

test("ignores thought parts and falls back to a direct response text value", () => {
  assert.equal(
    extractGeminiResponseText({
      candidates: [
        {
          content: {
            parts: [{ thought: true, text: "private reasoning" }],
          },
        },
      ],
      text: "{\"ok\":true}",
    }),
    "{\"ok\":true}",
  );
});

test("rejects an actually empty response", () => {
  assert.throws(
    () => extractGeminiResponseText({ candidates: [] }),
    /empty response/,
  );
});

test("normalizes the alternate payload from existing paid Batch jobs", () => {
  assert.deepEqual(
    normalizeVisualMomentPayload({
      clip_id: "clip-1",
      visual_description: "A dog walks beside a person.",
      evidence_ids: ["frame-1", "frame-2"],
      moment_range_ms: [0, 15_000],
    }),
    {
      description: "A dog walks beside a person.",
      tags: [],
      facets: {
        setting: [],
        weather: [],
        timeOfDay: [],
        dominantColors: [],
        mood: [],
        objects: [],
        actions: [],
        visiblePeople: [],
        contentType: "unknown",
        speechState: "unknown",
      },
      evidenceFrameIds: ["frame-1", "frame-2"],
      evidenceUtteranceIds: ["frame-1", "frame-2"],
      confidence: 0.5,
    },
  );
});

test("normalizes the evidence field variants found in existing jobs", () => {
  const variants = [
    {
      input: {
        description: "A person walks a dog.",
        frames: ["frame-1"],
        transcript: ["utterance-1"],
      },
      frameIds: ["frame-1"],
      utteranceIds: ["utterance-1"],
    },
    {
      input: {
        description: "An interview continues.",
        frame_ids: ["frame-2"],
        transcript_ids: ["utterance-2"],
      },
      frameIds: ["frame-2"],
      utteranceIds: ["utterance-2"],
    },
    {
      input: {
        visualDescription: "A mountain fills the background.",
        visual_evidence: ["frame-3"],
        transcript_evidence: [],
      },
      frameIds: ["frame-3"],
      utteranceIds: [],
    },
    {
      input: {
        description: "Two people talk.",
        evidence_ids: ["frame-4", "utterance-4"],
      },
      frameIds: ["frame-4", "utterance-4"],
      utteranceIds: ["frame-4", "utterance-4"],
    },
  ];

  for (const variant of variants) {
    const normalized = normalizeVisualMomentPayload(variant.input);
    assert.deepEqual(normalized.evidenceFrameIds, variant.frameIds);
    assert.deepEqual(normalized.evidenceUtteranceIds, variant.utteranceIds);
    assert.equal(normalized.facets.contentType, "unknown");
  }
});

test("does not loosen validation for normal structured payloads", () => {
  const payload = {
    description: "Already current",
    evidenceFrameIds: ["frame-1"],
    facets: {
      setting: [],
    },
  };
  assert.equal(normalizeVisualMomentPayload(payload), payload);
});

test("does not accept an unevidenced description as a legacy payload", () => {
  const payload = { description: "No source IDs." };
  assert.equal(normalizeVisualMomentPayload(payload), payload);
});
