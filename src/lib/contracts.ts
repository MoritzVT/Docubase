import { z } from "zod";

export const ProcessingStageSchema = z.enum([
  "discovered",
  "inspecting",
  "ready",
  "failed",
]);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

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

export type CreateProjectInput = Pick<
  Project,
  "id" | "ownerId" | "name" | "brief" | "knownNames" | "terminology" | "budgetPerFootageHour"
>;

export interface ImportProgress {
  completed: number;
  total: number;
  currentFilename: string;
}

