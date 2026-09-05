import assert from "node:assert/strict";
import test from "node:test";
import {
  extractiveClipDescription,
  sanitizeClipSummary,
  selectRepresentativeItems,
  selectTranscriptEvidence,
} from "../lib/clip-summary.js";

test("selects evidence across the full clip", () => {
  assert.deepEqual(
    selectRepresentativeItems([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4),
    [0, 3, 6, 9],
  );
  assert.deepEqual(selectRepresentativeItems([0, 1, 2], 8), [0, 1, 2]);
});

test("caps representative transcript evidence by item and character count", () => {
  const evidence = [
    { id: "u1", text: "first" },
    { id: "u2", text: "second" },
    { id: "u3", text: "third" },
    { id: "u4", text: "fourth" },
  ];
  assert.deepEqual(
    selectTranscriptEvidence(evidence, 3, 11).map((item) => item.id),
    ["u1", "u3"],
  );
});

test("sanitizes a whole-clip summary against frame and transcript allowlists", () => {
  assert.deepEqual(
    sanitizeClipSummary(
      {
        description: "Joost discusses community fundraising while cycling.",
        tags: ["Fundraising", "Cycling", "fundraising"],
        evidenceFrameIds: ["frame-1", "not-allowed"],
        evidenceUtteranceIds: ["utterance-1", "not-allowed"],
        confidence: 1.5,
      },
      ["frame-1"],
      ["utterance-1"],
    ),
    {
      description: "Joost discusses community fundraising while cycling.",
      tags: ["fundraising", "cycling"],
      evidenceFrameIds: ["frame-1"],
      evidenceUtteranceIds: ["utterance-1"],
      confidence: 1,
    },
  );
});

test("accepts legacy evidence names but rejects unsupported claims", () => {
  assert.deepEqual(
    sanitizeClipSummary(
      {
        summary: "A silent landscape sequence.",
        frames: ["frame-2"],
      },
      ["frame-2"],
      [],
    ).evidenceFrameIds,
    ["frame-2"],
  );
  assert.throws(
    () =>
      sanitizeClipSummary(
        {
          description: "An interview about climate.",
          frames: ["frame-2"],
        },
        ["frame-2"],
        ["utterance-2"],
      ),
    /transcript evidence/,
  );
});

test("builds a transcript-aware fallback for existing paid results", () => {
  const description = extractiveClipDescription(
    ["A woman sits in an interview setting.", "She gestures while speaking."],
    [{ id: "u1", text: "We need a different way to fund climate projects." }],
  );
  assert.match(description, /centers on the speaker’s account/);
  assert.match(description, /fund climate projects/);
  assert.match(description, /Visually, it shows/);
  assert.doesNotMatch(description, /[“”]/);
});

test("ignores filler and repeated takes in the reported shelter-dog example", () => {
  const description = extractiveClipDescription(
    ["A woman speaks in a seated interview shot."],
    [
      { id: "u1", text: "And I'm good." },
      {
        id: "u2",
        text: "After two hundred and seventy days of being just another shelter dog, he just finally got to be Max.",
      },
      {
        id: "u3",
        text: "Let me say it again. Yeah. After two hundred and seventy days of being just another shelter dog, he finally got to be Max.",
      },
    ],
  );
  assert.match(description, /two hundred and seventy days/);
  assert.match(description, /shelter dog/);
  assert.doesNotMatch(description, /I'm good|Let me say it again|[“”]/);
  assert.ok(description.length < 300);
});

test("falls back to a broad interview description when dialogue is fragments", () => {
  const description = extractiveClipDescription(
    ["A woman sits indoors and speaks to an interviewer."],
    [
      { id: "u1", text: "So" },
      { id: "u2", text: "how did this dog" },
      {
        id: "u3",
        text: "Mhmm. Great. I only have one other question for you. Okay. Cool. And it's",
      },
    ],
  );
  assert.equal(
    description,
    "Interview or conversational footage showing a woman sits indoors and speaks to an interviewer.",
  );
  assert.doesNotMatch(description, /question|[“”]/);
});
