import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTranscriptPassages,
  filenameAliases,
  prepareSearchDocument,
  prepareSearchQuery,
  searchDocumentId,
} from "../lib/search-core.js";

test("uses Gemini Embedding 2 retrieval formatting", () => {
  assert.equal(
    prepareSearchQuery("a biker climbing a mountain"),
    "task: search result | query: a biker climbing a mountain",
  );
  assert.equal(
    prepareSearchDocument("A001.MP4", "Cyclist on a steep road"),
    "title: A001.MP4 | text: Cyclist on a steep road",
  );
});

test("normalizes filename aliases with and without the extension", () => {
  assert.deepEqual(filenameAliases("  Interview 01.MP4 "), [
    "interview 01.mp4",
    "interview 01",
  ]);
});

test("builds searchable transcript windows across the complete clip", () => {
  const passages = buildTranscriptPassages([
    { id: "u1", startMs: 1_000, endMs: 8_000, text: "The ride begins in Seattle." },
    { id: "u2", startMs: 40_000, endMs: 50_000, text: "We climb toward the mountain." },
    { id: "u3", startMs: 76_000, endMs: 82_000, text: "Rain arrives near the summit." },
  ], 90_000);
  assert.deepEqual(passages.map(({ startMs, endMs }) => [startMs, endMs]), [
    [0, 45_000],
    [45_000, 90_000],
  ]);
  assert.deepEqual(passages[1].utteranceIds, ["u2", "u3"]);
  assert.match(passages[1].text, /mountain.*Rain/s);
});

test("keeps a short clip as one passage and skips silent windows", () => {
  assert.deepEqual(
    buildTranscriptPassages([
      { id: "u1", startMs: 2_000, endMs: 5_000, text: "A short answer." },
    ], 18_000).map(({ startMs, endMs }) => [startMs, endMs]),
    [[0, 18_000]],
  );
});

test("creates stable, Firestore-safe document ids", () => {
  const first = searchDocumentId("visual", "clip/with/slashes", "moment-1");
  const second = searchDocumentId("visual", "clip/with/slashes", "moment-1");
  assert.equal(first, second);
  assert.match(first, /^visual-[a-f0-9]{24}$/);
});
