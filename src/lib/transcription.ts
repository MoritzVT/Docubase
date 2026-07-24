import { httpsCallable } from "firebase/functions";
import type {
  BeginTranscriptionResponse,
  CompleteTranscriptionResponse,
} from "./contracts";
import { requireFunctions } from "./firebase";

export const DEEPGRAM_ESTIMATED_USD_PER_MINUTE = 0.0068;

export function estimateTranscriptionCost(durationMs: number): number {
  return roundUsd(
    (Math.max(0, durationMs) / 60_000) *
      DEEPGRAM_ESTIMATED_USD_PER_MINUTE,
  );
}

export async function beginTranscriptionChunk(input: {
  projectId: string;
  clipId: string;
  chunkIndex: number;
}): Promise<BeginTranscriptionResponse> {
  const callable = httpsCallable<
    typeof input,
    BeginTranscriptionResponse
  >(requireFunctions(), "beginTranscriptionChunk");
  const response = await callable(input);
  return response.data;
}

export async function completeCloudTranscriptionChunk(input: {
  projectId: string;
  reservationId: string;
  requestId: string;
}): Promise<CompleteTranscriptionResponse> {
  const callable = httpsCallable<
    typeof input,
    CompleteTranscriptionResponse
  >(requireFunctions(), "completeTranscriptionChunk");
  const response = await callable(input);
  return response.data;
}

export async function releaseCloudTranscriptionChunk(input: {
  projectId: string;
  reservationId: string;
}): Promise<void> {
  const callable = httpsCallable<
    typeof input,
    { released: boolean }
  >(requireFunctions(), "releaseTranscriptionChunk");
  await callable(input);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
