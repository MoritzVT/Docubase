import { z } from "zod";

export const ProcessingStageSchema = z.enum([
  "discovered",
  "inspecting",
  "ready",
  "failed",
]);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

export const TranscriptionStageSchema = z.enum([
  "not_started",
  "queued",
  "extracting",
  "ready",
  "transcribing",
  "syncing",
  "complete",
  "failed",
]);
export type TranscriptionStage = z.infer<typeof TranscriptionStageSchema>;

export const VisualStageSchema = z.enum([
  "not_started",
  "extracting",
  "ready",
  "uploading",
  "batched",
  "analyzing",
  "complete",
  "failed",
]);
export type VisualStage = z.infer<typeof VisualStageSchema>;

export const FrameRateSchema = z.object({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
  dropFrame: z.boolean(),
});
export type FrameRate = z.infer<typeof FrameRateSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  brief: z.string().max(5000),
  knownNames: z.array(z.string().trim().min(1)).max(100),
  terminology: z.array(z.string().trim().min(1)).max(200),
  budgetPerFootageHour: z.number().positive(),
  memberIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ClipManifestSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  fingerprint: z.string().min(16),
  filename: z.string().min(1),
  fileExtension: z.string().min(1),
  portableDirectoryHint: z.string(),
  durationMs: z.number().int().nonnegative(),
  frameRate: FrameRateSchema,
  startTimecodeFrames: z.number().int().nonnegative().nullable(),
  recordedAt: z.string().datetime().nullable(),
  sourceModifiedAt: z.string().datetime().nullable(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  videoCodec: z.string(),
  audioCodec: z.string().nullable(),
  hasAudio: z.boolean(),
  fileSizeBytes: z.number().int().nonnegative(),
  posterPath: z.string().nullable(),
  stage: ProcessingStageSchema,
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ClipManifest = z.infer<typeof ClipManifestSchema>;

export const AnalysisModeSchema = z.enum(["batch", "fast"]);
export type AnalysisMode = z.infer<typeof AnalysisModeSchema>;

export const IngestEstimateSchema = z.object({
  projectId: z.string().min(1),
  clipCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().int().nonnegative(),
  sourceBytes: z.number().int().nonnegative(),
  estimatedRetainedBytes: z.number().int().nonnegative(),
  estimatedProviderCostUsd: z.number().nonnegative(),
});
export type IngestEstimate = z.infer<typeof IngestEstimateSchema>;

export const LocalProjectSchema = ProjectSchema.extend({
  clipCount: z.number().int().nonnegative().default(0),
  totalDurationMs: z.number().int().nonnegative().default(0),
});
export type LocalProject = z.infer<typeof LocalProjectSchema>;

export const TranscriptWordSchema = z.object({
  text: z.string(),
  punctuatedText: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  speaker: z.number().int().nonnegative().nullable(),
  speakerConfidence: z.number().min(0).max(1).nullable(),
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptUtteranceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  clipId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speaker: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
  text: z.string(),
  words: z.array(TranscriptWordSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TranscriptUtterance = z.infer<typeof TranscriptUtteranceSchema>;

export const TranscriptionChunkSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  clipId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  stage: TranscriptionStageSchema,
  attemptCount: z.number().int().nonnegative(),
  transcriptionId: z.string().nullable(),
  model: z.string().nullable(),
  modelVersion: z.string().nullable(),
  language: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type TranscriptionChunk = z.infer<typeof TranscriptionChunkSchema>;

export const ClipTranscriptSummarySchema = z.object({
  clipId: z.string().min(1),
  stage: TranscriptionStageSchema,
  totalChunks: z.number().int().nonnegative(),
  completedChunks: z.number().int().nonnegative(),
  utteranceCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type ClipTranscriptSummary = z.infer<
  typeof ClipTranscriptSummarySchema
>;

export const TranscriptChunkDocumentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  clipId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  requestId: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().nullable(),
  language: z.string().min(1),
  utteranceCount: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TranscriptChunkDocument = z.infer<
  typeof TranscriptChunkDocumentSchema
>;

export const TranscriptChunkPayloadSchema = z.object({
  chunk: TranscriptChunkDocumentSchema,
  utterances: z.array(TranscriptUtteranceSchema),
});
export type TranscriptChunkPayload = z.infer<
  typeof TranscriptChunkPayloadSchema
>;

export const TranscriptSearchMatchSchema = z.object({
  clipId: z.string().min(1),
  utteranceId: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speaker: z.number().int().nonnegative().nullable(),
  text: z.string(),
});
export type TranscriptSearchMatch = z.infer<
  typeof TranscriptSearchMatchSchema
>;

export const VisualFrameSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  clipId: z.string().min(1),
  momentId: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  localPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileSizeBytes: z.number().int().positive(),
  changeScore: z.number().min(0).max(1),
  stage: VisualStageSchema,
  storagePath: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VisualFrame = z.infer<typeof VisualFrameSchema>;

export const VisualFrameDocumentSchema = VisualFrameSchema.omit({
  localPath: true,
  error: true,
}).extend({
  stage: z.literal("ready"),
  storagePath: z.string().min(1),
});
export type VisualFrameDocument = z.infer<
  typeof VisualFrameDocumentSchema
>;

export const VisualFacetsSchema = z.object({
  setting: z.array(z.string()).max(8),
  weather: z.array(z.string()).max(6),
  timeOfDay: z.array(z.string()).max(4),
  dominantColors: z.array(z.string()).max(8),
  mood: z.array(z.string()).max(8),
  objects: z.array(z.string()).max(20),
  actions: z.array(z.string()).max(12),
  visiblePeople: z.array(z.string()).max(12),
  contentType: z.enum([
    "interview",
    "b-roll",
    "archive",
    "action",
    "establishing",
    "mixed",
    "unknown",
  ]),
  speechState: z.enum([
    "no-speech",
    "single-speaker",
    "multiple-speakers",
    "voice-over",
    "unknown",
  ]),
});
export type VisualFacets = z.infer<typeof VisualFacetsSchema>;

export const VisualMomentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  clipId: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  frameIds: z.array(z.string().min(1)).min(1),
  stage: VisualStageSchema,
  generatedDescription: z.string().max(1_000),
  description: z.string().max(1_000),
  generatedTags: z.array(z.string()).max(40),
  tags: z.array(z.string()).max(40),
  facets: VisualFacetsSchema.nullable(),
  evidenceFrameIds: z.array(z.string().min(1)),
  evidenceUtteranceIds: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  model: z.string().nullable(),
  modelVersion: z.string().nullable(),
  batchJobId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VisualMoment = z.infer<typeof VisualMomentSchema>;

export const ClipVisualSummarySchema = z.object({
  clipId: z.string().min(1),
  stage: VisualStageSchema,
  totalFrames: z.number().int().nonnegative(),
  uploadedFrames: z.number().int().nonnegative(),
  momentCount: z.number().int().nonnegative(),
  completedMoments: z.number().int().nonnegative(),
  significantChangeCount: z.number().int().nonnegative(),
  significantChangeRatio: z.number().min(0).max(1),
  medianChangeScore: z.number().min(0).max(1),
  maximumChangeScore: z.number().min(0).max(1),
  description: z.string(),
  tags: z.array(z.string()),
  estimatedCostUsd: z.number().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type ClipVisualSummary = z.infer<typeof ClipVisualSummarySchema>;

export const ClipVisualMetadataSchema = z.object({
  clipId: z.string().min(1),
  generatedDescription: z.string().default(""),
  description: z.string(),
  generatedTags: z.array(z.string()).default([]),
  tags: z.array(z.string()),
  generatedTranscriptDescription: z.string().default(""),
  generatedVisualDescription: z.string().default(""),
  generatedTranscriptTags: z.array(z.string()).default([]),
  generatedVisualTags: z.array(z.string()).default([]),
  keywordProvenance: z.array(z.object({
    value: z.string(),
    sources: z.array(z.enum(["transcript", "visual", "editor"])),
    evidenceUtteranceIds: z.array(z.string()).default([]),
    evidenceFrameIds: z.array(z.string()).default([]),
  })).default([]),
  analysisRoute: z.enum(["stableInterview", "fullVisual"]).nullable().default(null),
  analysisVersion: z.string().nullable().default(null),
  visualStage: VisualStageSchema,
  visualFacets: z.object({
    contentTypes: z.array(z.string()),
    speechStates: z.array(z.string()),
    settings: z.array(z.string()),
    weather: z.array(z.string()),
    colors: z.array(z.string()),
    moods: z.array(z.string()),
    actions: z.array(z.string()),
  }),
});
export type ClipVisualMetadata = z.infer<
  typeof ClipVisualMetadataSchema
>;

export const VisualAnalysisJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  clipId: z.string().min(1).nullable(),
  kind: z.literal("clip"),
  analysisMode: AnalysisModeSchema.default("batch"),
  batchName: z.string().min(1),
  state: z.string().min(1),
  phase: z.string().nullable().default(null),
  route: z.enum(["stableInterview", "fullVisual"]).nullable().default(null),
  analysisVersion: z.string().nullable().default(null),
  momentIds: z.array(z.string()),
  estimatedCostUsd: z.number().nonnegative(),
  actualCostUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VisualAnalysisJob = z.infer<
  typeof VisualAnalysisJobSchema
>;

export interface SubmitVisualAnalysisResponse {
  jobId: string;
  batchName: string;
  momentCount: number;
  estimatedCostUsd: number;
  alreadySubmitted: boolean;
}

export interface UploadVisualFrameResponse {
  storagePath: string;
  fileSizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface RefreshVisualAnalysisResponse {
  state: string;
  completed: boolean;
  completedMoments: number;
  failedMoments: number;
  summaryFailed?: boolean;
  route?: "stableInterview" | "fullVisual";
}

export interface DeleteProjectResponse {
  deleted: boolean;
  canceledBatchCount: number;
  uncanceledBatchCount: number;
}

export type CreateProjectInput = Pick<
  Project,
  "id" | "ownerId" | "name" | "brief" | "knownNames" | "terminology" | "budgetPerFootageHour"
>;

export interface ImportProgress {
  completed: number;
  total: number;
  currentFilename: string;
}
