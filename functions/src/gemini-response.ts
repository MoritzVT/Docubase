type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): PlainRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PlainRecord)
    : null;
}

export function extractGeminiResponseText(response: unknown): string {
  const record = plainRecord(response);
  const candidates = Array.isArray(record?.candidates)
    ? record.candidates
    : [];
  const candidate = plainRecord(candidates[0]);
  const content = plainRecord(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const candidateText = parts
    .map((part) => plainRecord(part))
    .filter((part): part is PlainRecord => part !== null && part.thought !== true)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");

  if (candidateText.trim()) return candidateText;

  // A direct generateContent response exposes a convenience `text` getter.
  // Batch responses are deserialized as plain objects, so that getter is absent.
  const convenienceText = record?.text;
  if (typeof convenienceText === "string" && convenienceText.trim()) {
    return convenienceText;
  }
  throw new Error("Gemini returned an empty response.");
}

export function normalizeVisualMomentPayload(value: unknown): unknown {
  const record = plainRecord(value);
  if (!record) return value;

  const facets = plainRecord(record.facets);
  if (facets) return value;

  const description =
    typeof record.description === "string"
      ? record.description
      : typeof record.visualDescription === "string"
        ? record.visualDescription
        : typeof record.visual_description === "string"
          ? record.visual_description
          : null;
  const legacyEvidenceKeys = [
    "evidence_ids",
    "evidence_frame_ids",
    "frame_ids",
    "frames",
    "visual_evidence",
    "evidence_utterance_ids",
    "transcript_ids",
    "transcript",
    "transcript_evidence",
    "transcript_chunks",
  ];
  if (
    description === null ||
    !legacyEvidenceKeys.some((key) => Array.isArray(record[key]))
  ) {
    return value;
  }

  const arrayStrings = (keys: string[]): string[] =>
    keys.flatMap((key) =>
      Array.isArray(record[key])
        ? record[key].filter((item): item is string => typeof item === "string")
        : [],
    );
  const sharedEvidence = arrayStrings(["evidence_ids"]);

  // Early Goal 3 Batch responses used these alternate names even though the
  // request supplied a JSON schema. Preserve those already-paid results while
  // leaving the normal structured-output path strict.
  return {
    description,
    tags: Array.isArray(record.tags) ? record.tags : [],
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
    evidenceFrameIds: [
      ...sharedEvidence,
      ...arrayStrings([
        "evidence_frame_ids",
        "frame_ids",
        "frames",
        "visual_evidence",
      ]),
    ],
    evidenceUtteranceIds: [
      ...sharedEvidence,
      ...arrayStrings([
        "evidence_utterance_ids",
        "transcript_ids",
        "transcript",
        "transcript_evidence",
        "transcript_chunks",
      ]),
    ],
    confidence:
      typeof record.confidence === "number" ? record.confidence : 0.5,
  };
}
