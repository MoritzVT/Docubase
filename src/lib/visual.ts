import { httpsCallable } from "firebase/functions";
import type {
  RefreshVisualAnalysisResponse,
  SubmitVisualAnalysisResponse,
  UploadVisualFrameResponse,
  VisualFrame,
  VisualFrameDocument,
  VisualAnalysisJob,
  AnalysisMode,
} from "./contracts";
import { requireFunctions } from "./firebase";

export const GEMINI_BATCH_INPUT_USD_PER_MILLION = 0.15;
export const GEMINI_BATCH_OUTPUT_USD_PER_MILLION = 1.25;
export const GEMINI_STANDARD_INPUT_USD_PER_MILLION = 0.30;
export const GEMINI_STANDARD_OUTPUT_USD_PER_MILLION = 2.50;
export const GEMINI_IMAGE_TOKENS = 258;
export const ESTIMATED_PROMPT_TOKENS_PER_MOMENT = 300;
export const ESTIMATED_OUTPUT_TOKENS_PER_MOMENT = 180;
export const ESTIMATED_PROMPT_TOKENS_PER_CLIP_SUMMARY = 350;
export const ESTIMATED_OUTPUT_TOKENS_PER_CLIP_SUMMARY = 180;
export const TRANSCRIPT_SECTION_MAX_CHARACTERS = 2_400_000;

export interface VisualAnalysisProgressStage {
  percent: number;
  label: string;
}

/**
 * Neither provider mode exposes one trustworthy end-to-end percentage. These
 * values describe completed Docubase pipeline stages instead of inventing a
 * time estimate.
 */
export function visualAnalysisProgressStage(
  job: VisualAnalysisJob,
): VisualAnalysisProgressStage {
  if (job.state === "complete" || job.phase === "complete") {
    return { percent: 100, label: "Description and tags are ready" };
  }
  if (job.phase === "visual") {
    return {
      percent: 85,
      label: "Analyzing the visual sequence and building tags",
    };
  }
  if (job.phase === "awaitingVisualUploads") {
    return {
      percent: 65,
      label: "Interview check complete; preparing the visual sequence",
    };
  }
  if (job.phase === "transcriptSynthesis") {
    return {
      percent: 50,
      label: "Combining the full transcript analysis",
    };
  }
  if (job.phase === "foundation") {
    return {
      percent: 30,
      label: "Analyzing the transcript and interview-check image",
    };
  }
  return { percent: 10, label: "Submitting the clip for AI analysis" };
}

export function estimateVisualAnalysisCost(
  frameCount: number,
  momentCount: number,
  additionalInputTokens = 0,
  summaryClipCount = 0,
  summaryFrameCount = 0,
  summaryInputTokens = 0,
  analysisMode: AnalysisMode = "batch",
): number {
  const inputRate = analysisMode === "fast"
    ? GEMINI_STANDARD_INPUT_USD_PER_MILLION
    : GEMINI_BATCH_INPUT_USD_PER_MILLION;
  const outputRate = analysisMode === "fast"
    ? GEMINI_STANDARD_OUTPUT_USD_PER_MILLION
    : GEMINI_BATCH_OUTPUT_USD_PER_MILLION;
  const inputCost =
    ((Math.max(0, frameCount) * GEMINI_IMAGE_TOKENS +
      Math.max(0, momentCount) * ESTIMATED_PROMPT_TOKENS_PER_MOMENT +
      Math.max(0, additionalInputTokens) +
      Math.max(0, summaryFrameCount) * GEMINI_IMAGE_TOKENS +
      Math.max(0, summaryClipCount) *
        ESTIMATED_PROMPT_TOKENS_PER_CLIP_SUMMARY +
      Math.max(0, summaryInputTokens)) *
      inputRate) /
    1_000_000;
  const outputCost =
    ((Math.max(0, momentCount) *
      ESTIMATED_OUTPUT_TOKENS_PER_MOMENT +
      Math.max(0, summaryClipCount) *
        ESTIMATED_OUTPUT_TOKENS_PER_CLIP_SUMMARY) *
      outputRate) /
    1_000_000;
  return roundUsd(inputCost + outputCost);
}

export async function uploadRetainedFrame(
  frame: VisualFrame,
  bytes: Uint8Array,
): Promise<VisualFrameDocument> {
  if (bytes.byteLength < 1 || bytes.byteLength > 100 * 1_024) {
    throw new Error("Retained visual frames must be between 1 byte and 100 KB.");
  }
  const storagePath =
    `projects/${frame.projectId}/clips/${frame.clipId}/frames/` +
    `${frame.id}.jpg`;
  const callable = httpsCallable<
    {
      projectId: string;
      clipId: string;
      frameId: string;
      momentId: string;
      timestampMs: number;
      width: number;
      height: number;
      changeScore: number;
      bytesBase64: string;
    },
    UploadVisualFrameResponse
  >(requireFunctions(), "uploadVisualFrame");
  const response = (
    await callable({
      projectId: frame.projectId,
      clipId: frame.clipId,
      frameId: frame.id,
      momentId: frame.momentId,
      timestampMs: frame.timestampMs,
      width: frame.width,
      height: frame.height,
      changeScore: frame.changeScore,
      bytesBase64: bytesToBase64(bytes),
    })
  ).data;
  if (response.storagePath !== storagePath) {
    throw new Error("The server returned an unexpected visual frame path.");
  }
  const document: VisualFrameDocument = {
    id: frame.id,
    projectId: frame.projectId,
    clipId: frame.clipId,
    momentId: frame.momentId,
    timestampMs: frame.timestampMs,
    width: frame.width,
    height: frame.height,
    fileSizeBytes: response.fileSizeBytes,
    changeScore: frame.changeScore,
    stage: "ready",
    storagePath,
    createdAt: response.createdAt,
    updatedAt: response.updatedAt,
  };
  return document;
}

export async function submitVisualAnalysis(input: {
  projectId: string;
  clipId: string;
  analysisMode: AnalysisMode;
  frames: Array<{
    id: string;
    momentId: string;
    timestampMs: number;
    fileSizeBytes: number;
    changeScore: number;
  }>;
  stability: {
    significantChangeCount: number;
    significantChangeRatio: number;
    medianChangeScore: number;
    maximumChangeScore: number;
  };
}): Promise<SubmitVisualAnalysisResponse> {
  const callable = httpsCallable<
    typeof input,
    SubmitVisualAnalysisResponse
  >(requireFunctions(), "submitVisualAnalysis");
  return (await callable(input)).data;
}

export async function refreshVisualAnalysis(input: {
  projectId: string;
  jobId: string;
}): Promise<RefreshVisualAnalysisResponse> {
  const callable = httpsCallable<
    typeof input,
    RefreshVisualAnalysisResponse
  >(requireFunctions(), "refreshVisualAnalysis");
  return (await callable(input)).data;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
