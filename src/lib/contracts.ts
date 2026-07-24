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
  reservationId: z.string().nullable(),
  deepgramRequestId: z.string().nullable(),
  model: z.string().nullable(),
  modelVersion: z.string().nullable(),
  estimatedCostUsd: z.number().nonnegative(),
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
  estimatedCostUsd: z.number().nonnegative(),
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

export interface BeginTranscriptionResponse {
  accessToken: string | null;
  expiresIn: number;
  reservationId: string;
  estimatedCostUsd: number;
  alreadyCompleted: boolean;
}

export interface CompleteTranscriptionResponse {
  actualCostUsd: number;
  projectActualUsd: number;
  projectReservedUsd: number;
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
