import { normalizeVisualMomentPayload } from "../gemini-response.js";
import {
  GEMINI_MODEL,
  arrayStrings,
  numeric,
  requirePlainRecord,
  uniqueStrings,
  type SanitizedMomentAnalysis,
  type VisualMomentInput,
} from "../shared.js";

export function emptyVisualMoment(
  projectId: string,
  clipId: string,
  moment: VisualMomentInput,
  jobId: string,
  timestamp: string,
  previous: FirebaseFirestore.DocumentData = {},
): Record<string, unknown> {
  const preserveEditorValues = momentHasEditorEdits(previous);
  return {
    id: moment.id,
    projectId,
    clipId,
    startMs: moment.startMs,
    endMs: moment.endMs,
    frameIds: moment.frames.map((frame) => frame.id),
    stage: "batched",
    generatedDescription: "",
    description: preserveEditorValues ? String(previous.description ?? "") : "",
    generatedTags: [],
    tags: preserveEditorValues ? arrayStrings(previous.tags) : [],
    facets: null,
    evidenceFrameIds: moment.frames.map((frame) => frame.id),
    evidenceUtteranceIds: [],
    confidence: 0,
    model: GEMINI_MODEL,
    modelVersion: null,
    batchJobId: jobId,
    error: null,
    createdAt: String(previous.createdAt ?? timestamp),
    updatedAt: timestamp,
  };
}

export function momentHasEditorEdits(
  moment: FirebaseFirestore.DocumentData,
): boolean {
  const description = String(moment.description ?? "");
  const generatedDescription = String(moment.generatedDescription ?? "");
  const tags = arrayStrings(moment.tags);
  const generatedTags = arrayStrings(moment.generatedTags);
  return (
    description !== generatedDescription ||
    JSON.stringify(tags) !== JSON.stringify(generatedTags)
  );
}

export function sanitizeMomentAnalysis(
  value: unknown,
  allowedFrameIds: string[],
): SanitizedMomentAnalysis {
  const record = requirePlainRecord(
    normalizeVisualMomentPayload(value),
    "moment analysis",
  );
  const facets = requirePlainRecord(record.facets, "visual facets");
  const contentTypes = [
    "interview",
    "b-roll",
    "archive",
    "action",
    "establishing",
    "mixed",
    "unknown",
  ] as const;
  const contentType = contentTypes.includes(
    facets.contentType as (typeof contentTypes)[number],
  )
    ? (facets.contentType as (typeof contentTypes)[number])
    : "unknown";
  const evidenceFrameIds = arrayStrings(record.evidenceFrameIds).filter((id) =>
    allowedFrameIds.includes(id),
  );
  if (evidenceFrameIds.length < 1) {
    throw new Error("The analysis did not cite a retained frame.");
  }
  return {
    description: String(record.description ?? "").trim().slice(0, 1_000),
    tags: uniqueStrings(arrayStrings(record.tags), 40),
    facets: {
      setting: uniqueStrings(arrayStrings(facets.setting), 8),
      weather: uniqueStrings(arrayStrings(facets.weather), 6),
      timeOfDay: uniqueStrings(arrayStrings(facets.timeOfDay), 4),
      dominantColors: uniqueStrings(
        arrayStrings(facets.dominantColors),
        8,
      ),
      mood: uniqueStrings(arrayStrings(facets.mood), 8),
      objects: uniqueStrings(arrayStrings(facets.objects), 20),
      actions: uniqueStrings(arrayStrings(facets.actions), 12),
      visiblePeople: uniqueStrings(arrayStrings(facets.visiblePeople), 12),
      contentType,
      speechState: "unknown",
    },
    evidenceFrameIds,
    evidenceUtteranceIds: [],
    confidence: Math.min(1, Math.max(0, numeric(record.confidence))),
  };
}

export function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 6 || code === "already-exists";
}

export function visualBatchDescriptors(value: unknown): Array<{
  name: string;
  requestType: "clipSummary" | "moments";
  momentIds: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const requestType =
      record.requestType === "clipSummary" ||
      record.requestType === "moments"
        ? record.requestType
        : null;
    if (!name || requestType === null) return [];
    return [
      {
        name,
        requestType,
        momentIds: arrayStrings(record.momentIds),
      },
    ];
  });
}
