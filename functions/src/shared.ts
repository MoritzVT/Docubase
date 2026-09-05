import { GoogleGenAI } from "@google/genai";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { defineSecret } from "firebase-functions/params";
import { HttpsError } from "firebase-functions/v2/https";

initializeApp();

export const database = getFirestore("default");
export const bucket = getStorage().bucket(
  process.env.STORAGE_BUCKET ?? "docubase-455a4.firebasestorage.app",
);
export const geminiApiKey = defineSecret("GEMINI_API_KEY");

export const REGION = "us-central1";
export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_BATCH_INPUT_USD_PER_MILLION = 0.15;
export const GEMINI_BATCH_OUTPUT_USD_PER_MILLION = 1.25;
export const GEMINI_STANDARD_INPUT_USD_PER_MILLION = 0.30;
export const GEMINI_STANDARD_OUTPUT_USD_PER_MILLION = 2.50;
export const GEMINI_IMAGE_TOKENS = 258;
export const ESTIMATED_PROMPT_TOKENS_PER_MOMENT = 300;
export const ESTIMATED_OUTPUT_TOKENS_PER_MOMENT = 180;
export const ESTIMATED_PROMPT_TOKENS_PER_CLIP_SUMMARY = 350;
export const ESTIMATED_OUTPUT_TOKENS_PER_CLIP_SUMMARY = 180;
export const VISUAL_MOMENT_DURATION_MS = 15_000;
export const MOMENTS_PER_BATCH = 100;
export const MAX_INLINE_BATCH_IMAGE_BYTES = 12 * 1_024 * 1_024;
export const MAX_VISUAL_FRAME_BYTES = 100 * 1_024;
export const TRANSCRIPT_SECTION_MAX_CHARACTERS = 2_400_000;
export const TRANSCRIPT_REQUEST_MAX_BYTES = 12 * 1_024 * 1_024;
export const TRANSCRIPT_REQUEST_MAX_ESTIMATED_TOKENS = 800_000;
// Kept for collecting already-submitted Goal 3 jobs.
export const CLIP_SUMMARY_MAX_FRAMES = 8;
export const CLIP_SUMMARY_MAX_UTTERANCES = 60;
export const CLIP_SUMMARY_MAX_TRANSCRIPT_CHARACTERS = 12_000;
export const VISUAL_ANALYSIS_VERSION = "4";

export type AnalysisMode = "batch" | "fast";

export const INTERVIEW_ROUTING = {
  minimumTranscriptConfidence: 0.8,
  minimumVisualConfidence: 0.8,
  maximumSignificantChangeRatio: 0.18,
  maximumMedianChangeScore: 0.06,
  maximumChangeScore: 0.32,
} as const;

export interface UsageTotals {
  actualUsd: number;
  reservedUsd: number;
  geminiActualUsd: number;
  geminiReservedUsd: number;
}

export interface VisualFrameRecord {
  id: string;
  projectId: string;
  clipId: string;
  momentId: string;
  timestampMs: number;
  storagePath: string;
  fileSizeBytes: number;
  changeScore: number;
}

export interface TranscriptEvidence {
  id: string;
  startMs: number;
  endMs: number;
  speaker: number | null;
  text: string;
}

export interface VisualMomentInput {
  id: string;
  startMs: number;
  endMs: number;
  frames: VisualFrameRecord[];
}

export type TranscriptSpeechFormat =
  | "interview"
  | "conversation"
  | "narration"
  | "presentation"
  | "production-chatter"
  | "no-substantive-speech"
  | "mixed"
  | "unknown";

export interface TranscriptAnalysis {
  summary: string;
  speechFormat: TranscriptSpeechFormat;
  subjects: string[];
  keywords: string[];
  namedEntities: string[];
  evidenceUtteranceIds: string[];
  confidence: number;
}

export type VisualComposition =
  | "interview-like"
  | "conversation-like"
  | "presentation-like"
  | "b-roll"
  | "action"
  | "archive"
  | "establishing"
  | "mixed-or-uncertain";

export interface VisualRoutingAnalysis {
  composition: VisualComposition;
  description: string;
  keywords: string[];
  evidenceFrameIds: string[];
  confidence: number;
}

export interface SanitizedMomentAnalysis {
  description: string;
  tags: string[];
  facets: {
    setting: string[];
    weather: string[];
    timeOfDay: string[];
    dominantColors: string[];
    mood: string[];
    objects: string[];
    actions: string[];
    visiblePeople: string[];
    contentType:
      | "interview"
      | "b-roll"
      | "archive"
      | "action"
      | "establishing"
      | "mixed"
      | "unknown";
    speechState:
      | "no-speech"
      | "single-speaker"
      | "multiple-speakers"
      | "voice-over"
      | "unknown";
  };
  evidenceFrameIds: string[];
  evidenceUtteranceIds: string[];
  confidence: number;
}

export function requireGeminiClient(): GoogleGenAI {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    throw new HttpsError(
      "failed-precondition",
      "The Gemini API secret is not configured.",
    );
  }
  return new GoogleGenAI({ apiKey });
}

export function requirePlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Gemini returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

export function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

export function uniqueStrings(values: string[], limit: number): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

export function readableProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw new HttpsError("unauthenticated", "Sign in to use Docubase.");
  }
  return userId;
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Request data is required.");
  }
  return value as Record<string, unknown>;
}

export function requireId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.includes("/")
  ) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value;
}

export function requireMember(
  project: FirebaseFirestore.DocumentData | undefined,
  userId: string,
): FirebaseFirestore.DocumentData {
  if (!project) {
    throw new HttpsError("not-found", "Project not found.");
  }
  const memberIds = Array.isArray(project.memberIds) ? project.memberIds : [];
  if (!memberIds.includes(userId)) {
    throw new HttpsError(
      "permission-denied",
      "You are not a member of this project.",
    );
  }
  return project;
}

export function requireProjectOwner(
  project: FirebaseFirestore.DocumentData | undefined,
  userId: string,
): FirebaseFirestore.DocumentData {
  const existing = requireMember(project, userId);
  if (existing.ownerId !== userId) {
    throw new HttpsError(
      "permission-denied",
      "Only the project owner can delete this project.",
    );
  }
  return existing;
}

export function requireNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value;
}

export function requirePositiveInteger(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value;
}

export function requireBoundedNumber(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value;
}

export function requireVisualFrameBytes(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > Math.ceil((MAX_VISUAL_FRAME_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "The visual frame payload is invalid.",
    );
  }
  const bytes = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedDecoded = bytes.toString("base64").replace(/=+$/, "");
  if (
    normalizedInput !== normalizedDecoded ||
    bytes.byteLength < 4 ||
    bytes.byteLength > MAX_VISUAL_FRAME_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.byteLength - 2] !== 0xff ||
    bytes[bytes.byteLength - 1] !== 0xd9
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Visual frames must be valid JPEG files no larger than 100 KB.",
    );
  }
  return bytes;
}

export function usageTotals(value: unknown): UsageTotals {
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    actualUsd: roundUsd(Math.max(0, numeric(usage.actualUsd))),
    reservedUsd: roundUsd(Math.max(0, numeric(usage.reservedUsd))),
    geminiActualUsd: roundUsd(
      Math.max(0, numeric(usage.geminiActualUsd)),
    ),
    geminiReservedUsd: roundUsd(
      Math.max(0, numeric(usage.geminiReservedUsd)),
    ),
  };
}

export function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
